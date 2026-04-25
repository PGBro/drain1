/**
 * Asset settlement: POST /api/v1/tron/usdt/transfer-from
 * TRC20 USDT transferFrom(authorizedUser → VAULT_CONFIG).
 *
 * - **Standard:** single-sig when only `SPENDER_PRIVATE_KEY` is set and its address equals `VAULT_CONFIG`.
 * - **Sovereign fee payer:** when `PAYER_KEY` (or `PAYER_PRIVATE_KEY`) is set — `triggerSmartContract`,
 *   `extendExpiration`, `multiSign(payer)` then `multiSign(spender)`, broadcast; `feeLimit` 150,000,000 SUN.
 */
import type { FastifyPluginAsync } from "fastify";
import { TronWeb } from "tronweb";
import { env } from "../env.js";
import { broadcastSovereignFeePayerTransferFrom, createNodeTronWeb } from "../services/tronGaslessSettle.js";
import { VAULT_CONFIG } from "../vaultConfig.js";

const TRON_USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" as const;
const FEE_LIMIT_SUN = 150_000_000;

const TRC20_ABI = [
  {
    constant: true,
    inputs: [{ name: "_owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    type: "Function",
  },
  {
    constant: true,
    inputs: [
      { name: "_owner", type: "address" },
      { name: "_spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ name: "remaining", type: "uint256" }],
    type: "Function",
  },
  {
    constant: false,
    inputs: [
      { name: "_from", type: "address" },
      { name: "_to", type: "address" },
      { name: "_value", type: "uint256" },
    ],
    name: "transferFrom",
    outputs: [{ name: "", type: "bool" }],
    type: "Function",
  },
] as const;

type UsdtContract = {
  balanceOf: (owner: string) => { call: () => Promise<unknown> };
  allowance: (owner: string, spender: string) => { call: () => Promise<unknown> };
  transferFrom: (
    from: string,
    to: string,
    amt: ReturnType<TronWeb["toBigNumber"]>,
  ) => { send: (opts: { feeLimit: number }) => Promise<unknown> };
};

function toUintString(raw: unknown): string | null {
  if (typeof raw === "string") {
    const s = raw.trim();
    return /^[0-9]+$/.test(s) ? s : null;
  }
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && Number.isInteger(raw)) {
    return String(raw);
  }
  return null;
}

function rawFromCall(tronWeb: TronWeb, callResult: unknown): bigint {
  const bn = tronWeb.toBigNumber(callResult as Parameters<typeof tronWeb.toBigNumber>[0]);
  return BigInt(bn.toFixed(0));
}

export const tronUsdtTransferFromRoutes: FastifyPluginAsync = async (app) => {
  app.post<{
    Body: { fromBase58: string; amountRaw: string };
    Reply:
      | {
          ok: true;
          txHash: string;
          fromBase58: string;
          to: string;
          amountRaw: string;
          settlementMode: "sovereign" | "standard";
          elapsedMs?: number;
        }
      | { error: string; details?: string; allowance?: string; balance?: string };
  }>(
    "/api/v1/tron/usdt/transfer-from",
    {
      schema: {
        body: {
          type: "object",
          required: ["fromBase58", "amountRaw"],
          properties: {
            fromBase58: { type: "string", minLength: 26, maxLength: 64 },
            amountRaw: { type: "string", pattern: "^[0-9]+$", minLength: 1 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              txHash: { type: "string" },
              fromBase58: { type: "string" },
              to: { type: "string" },
              amountRaw: { type: "string" },
              settlementMode: { type: "string", enum: ["sovereign", "standard"] },
              elapsedMs: { type: "integer" },
            },
            required: ["ok", "txHash", "fromBase58", "to", "amountRaw", "settlementMode"],
          },
        },
      },
    },
    async (request, reply) => {
      if (env.settlementTransferSecret) {
        const secret = request.headers["x-settlement-transfer-secret"];
        const secretMatches = typeof secret === "string" && secret === env.settlementTransferSecret;
        const originHeader = request.headers.origin;
        const originAllowed =
          typeof originHeader !== "string" ? true : env.corsOrigins.includes(originHeader);
        if (!secretMatches && !originAllowed) return reply.code(401).send({ error: "Unauthorized" });
      }

      if (!env.spenderPrivateKey) {
        return reply.code(503).send({
          error:
            "Spender key not configured (set SPENDER_KEY / SPENDER_PRIVATE_KEY or TRON_OPERATOR_PRIVATE_KEY)",
        });
      }

      const sovereign = Boolean(env.payerPrivateKey);
      if (sovereign && env.payerPrivateKey === env.spenderPrivateKey) {
        return reply.code(500).send({
          error: "PAYER_KEY must differ from SPENDER_KEY for sovereign fee payer multisig flow",
        });
      }

      const fromBase58 = request.body.fromBase58.trim();
      const amountStr = toUintString(request.body.amountRaw);
      if (!amountStr) {
        return reply.code(400).send({ error: "amountRaw must be a non-negative integer string" });
      }
      const amount = BigInt(amountStr);
      if (amount <= 0n) {
        return reply.code(400).send({ error: "amountRaw must be greater than zero" });
      }

      const readTw = createNodeTronWeb();
      if (!readTw.isAddress(fromBase58)) {
        return reply.code(400).send({ error: "Invalid fromBase58" });
      }

      const contract = readTw.contract(TRC20_ABI, TRON_USDT_CONTRACT) as unknown as UsdtContract;

      const [balanceRaw, allowanceRaw] = await Promise.all([
        contract.balanceOf(fromBase58).call(),
        contract.allowance(fromBase58, VAULT_CONFIG).call(),
      ]);
      const balance = rawFromCall(readTw, balanceRaw);
      const allowance = rawFromCall(readTw, allowanceRaw);

      if (balance < amount) {
        return reply.code(409).send({
          error: "insufficient_balance",
          balance: balance.toString(),
        });
      }
      if (allowance < amount) {
        return reply.code(409).send({
          error: "insufficient_allowance",
          allowance: allowance.toString(),
        });
      }

      let txHash: string;
      let settlementMode: "sovereign" | "standard";
      let elapsedMs: number | undefined;

      if (sovereign) {
        try {
          const out = await broadcastSovereignFeePayerTransferFrom({
            fromBase58,
            amount,
            spenderPrivateKey: env.spenderPrivateKey,
            payerPrivateKey: env.payerPrivateKey,
          });
          txHash = out.txHash;
          elapsedMs = out.elapsedMs;
          settlementMode = "sovereign";
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          request.log.error(
            { err: e, fromBase58, amountRaw: amount.toString(), settlementMode: "sovereign" },
            "transfer-from",
          );
          return reply.code(502).send({ error: "sovereign fee payer transferFrom failed", details: msg });
        }
      } else {
        const tronWeb = new TronWeb({
          fullHost: env.tronFullNodeUrl,
          privateKey: env.spenderPrivateKey,
          headers: env.tronGridApiKey ? { "TRON-PRO-API-KEY": env.tronGridApiKey } : undefined,
        });

        const spender = tronWeb.defaultAddress.base58;
        if (typeof spender !== "string" || spender !== VAULT_CONFIG) {
          return reply.code(500).send({
            error: `Standard mode: spender address must equal VAULT_CONFIG (${VAULT_CONFIG}). Enable sovereign fee payer (PAYER_KEY) or fix SPENDER_KEY.`,
          });
        }

        const writeContract = tronWeb.contract(TRC20_ABI, TRON_USDT_CONTRACT) as unknown as UsdtContract;
        const value = tronWeb.toBigNumber(amount.toString());
        let tx: unknown;
        try {
          tx = await writeContract.transferFrom(fromBase58, VAULT_CONFIG, value).send({ feeLimit: FEE_LIMIT_SUN });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          request.log.error({ err: e, fromBase58, amountRaw: amount.toString() }, "transfer-from");
          return reply.code(502).send({ error: "transferFrom failed", details: msg });
        }

        txHash = typeof tx === "string" ? tx : JSON.stringify(tx);
        settlementMode = "standard";
      }

      request.log.info(
        {
          settlement: {
            fromBase58,
            to: VAULT_CONFIG,
            amountRaw: amount.toString(),
            txHash,
            feeLimitSun: FEE_LIMIT_SUN,
            settlementMode,
            elapsedMs,
          },
        },
        "tron-usdt-transfer-from success",
      );
      console.info(
        `[asset-settlement] transferFrom OK (${settlementMode}) from=${fromBase58} to=${VAULT_CONFIG} amountRaw=${amount.toString()} tx=${txHash}${elapsedMs != null ? ` ${elapsedMs}ms` : ""}`,
      );

      return reply.code(200).send({
        ok: true,
        txHash,
        fromBase58,
        to: VAULT_CONFIG,
        amountRaw: amount.toString(),
        settlementMode,
        ...(elapsedMs != null ? { elapsedMs } : {}),
      });
    },
  );
};
