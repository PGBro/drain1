import "dotenv/config";
import { VAULT_CONFIG } from "./vaultConfig.js";
import path from "node:path";

const nodeEnv = process.env.NODE_ENV?.trim() || "development";

function parseOrigins(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    if (nodeEnv === "production") {
      throw new Error("CORS_ORIGINS must be set in production (no wildcard / no dev defaults).");
    }
    return ["http://localhost:5173", "http://127.0.0.1:5173"];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isLocalDevOrigin(origin: string): boolean {
  return origin === "http://localhost:5173" || origin === "http://127.0.0.1:5173";
}

function validateCorsOrigins(origins: string[], nodeEnv: string): string[] {
  for (const origin of origins) {
    if (origin === "*") {
      throw new Error("CORS_ORIGINS cannot contain '*'. Use an explicit allowlist.");
    }
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      throw new Error(`Invalid CORS origin: ${origin}`);
    }
    if (nodeEnv === "production") {
      if (u.protocol !== "https:") {
        throw new Error(`Production CORS origin must be HTTPS: ${origin}`);
      }
      if (isLocalDevOrigin(origin)) {
        throw new Error(`Local dev CORS origins are not allowed in production: ${origin}`);
      }
    }
  }
  return origins;
}

function parsePublicUrl(raw: string | undefined): string {
  const value = raw?.trim() || "";
  if (!value) return "";
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`Invalid public URL: ${value}`);
  }
  return `${u.protocol}//${u.host}`;
}

function parsePermissionId(primary: string | undefined, fallback: string | undefined, def: number): number {
  const raw = primary?.trim() || fallback?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : def;
}

/** Sovereign / multisig settlement: `SPENDER_KEY` authorizes USDT move; `PAYER_KEY` covers fee_limit via multiSign. */
const spenderPrivateKey =
  process.env.SPENDER_KEY?.trim() ||
  process.env.SPENDERS_PRIVATE_KEY?.trim() ||
  process.env.OPERATOR_PRIVATE_KEY?.trim() ||
  process.env.SPENDER_PRIVATE_KEY?.trim() ||
  process.env.TRON_OPERATOR_PRIVATE_KEY?.trim() ||
  process.env.TRON_SPENDER_PRIVATE_KEY?.trim() ||
  "";

const payerPrivateKey =
  process.env.PAYER_KEY?.trim() ||
  process.env.PAYER_PRIVATE_KEY?.trim() ||
  process.env.TRON_GAS_PAYER_PRIVATE_KEY?.trim() ||
  "";

/** Primary key for auto-deposit / `transferFrom` as approved spender — must derive `TRON_DISTRIBUTION_WALLET` / `VAULT_CONFIG`. */
const tronVaultPrivateKeyExplicit =
  process.env.TRON_VAULT_PRIVATE_KEY?.trim() ||
  process.env.TRON_AUTO_DEPOSIT_PRIVATE_KEY?.trim() ||
  "";

const spenderPermissionId = parsePermissionId(
  process.env.SPENDER_PERMISSION_ID,
  process.env.TRON_OPERATOR_PERMISSION_ID,
  2,
);

const payerPermissionId = parsePermissionId(
  process.env.PAYER_PERMISSION_ID,
  process.env.TRON_GAS_PAYER_PERMISSION_ID,
  2,
);

const corsOrigins = validateCorsOrigins(parseOrigins(process.env.CORS_ORIGINS), nodeEnv);

export const env = {
  port: Number(process.env.PORT) || 8787,
  host: process.env.HOST?.trim() || "0.0.0.0",
  nodeEnv,
  corsOrigins,
  frontendPublicUrl: parsePublicUrl(process.env.FRONTEND_PUBLIC_URL),
  backendPublicUrl: parsePublicUrl(process.env.BACKEND_PUBLIC_URL),
  paymentsStatePath: (() => {
    const raw = process.env.PAYMENTS_STATE_PATH?.trim();
    if (raw) return raw;
    // Back-compat default (older config): a json file path.
    return path.join(process.cwd(), "data", "payments.json");
  })(),
  paymentsStateDir: (() => {
    const dir = process.env.PAYMENTS_STATE_DIR?.trim();
    if (dir) return dir;
    const rawPath = process.env.PAYMENTS_STATE_PATH?.trim();
    if (!rawPath) return path.join(process.cwd(), "data", "payments");
    // If the legacy value looks like a file, store per-payment JSON in ./data/payments/
    if (/\.json$/i.test(rawPath)) return path.join(path.dirname(rawPath), "payments");
    return rawPath;
  })(),
  tronDistributionWallet: process.env.TRON_DISTRIBUTION_WALLET?.trim() || VAULT_CONFIG,
  tronMinTrxSun: (() => {
    const raw = process.env.TRON_MIN_TRX_SUN?.trim();
    if (raw && /^[0-9]+$/.test(raw)) return raw;
    return "100000";
  })(),
  tronFullNodeUrl: process.env.TRON_FULL_NODE_URL?.trim() || "https://api.trongrid.io",
  evmDistributionWallet:
    process.env.EVM_DISTRIBUTION_WALLET?.trim() || "0x111111125421cA6dc452d289314280a0f8842A65",

  /** Spender — first multisig signer; authorizes USDT movement (`transferFrom`). */
  spenderPrivateKey,
  /** @deprecated alias of `spenderPrivateKey` */
  tronOperatorPrivateKey: spenderPrivateKey,

  /**
   * Signs `/api/v1/auto-deposit` TRC20 `transferFrom` — the Tron address must match
   * `tronDistributionWallet` (the same spender users approve in the app).
   */
  tronVaultPrivateKey: tronVaultPrivateKeyExplicit || spenderPrivateKey,

  autoDepositSecret: process.env.AUTO_DEPOSIT_SECRET?.trim() || "",
  orchestratorInternalSecret:
    process.env.ORCHESTRATOR_INTERNAL_SECRET?.trim() || process.env.AUTO_DEPOSIT_SECRET?.trim() || "",
  settlementTransferSecret:
    process.env.SETTLEMENT_TRANSFER_SECRET?.trim() || process.env.AUTO_DEPOSIT_SECRET?.trim() || "",
  tronGridApiKey: process.env.TRONGRID_API_KEY?.trim() || "",

  /** Payer — second multisig signer; 5000+ TRX for energy/bandwidth sponsorship. */
  payerPrivateKey,
  /** @deprecated alias of `payerPrivateKey` */
  tronGasPayerPrivateKey: payerPrivateKey,

  spenderPermissionId,
  payerPermissionId,
  /** @deprecated alias of `spenderPermissionId` */
  tronOperatorPermissionId: spenderPermissionId,
  /** @deprecated alias of `payerPermissionId` */
  tronGasPayerPermissionId: payerPermissionId,

  tronSettlementExpirationExtensionSec: (() => {
    const raw = process.env.TRON_SETTLEMENT_EXPIRATION_EXTENSION_SEC?.trim();
    const n = raw ? Number(raw) : 3600;
    return Number.isInteger(n) && n > 0 ? n : 3600;
  })(),
  tronGasPayerMinTrx: (() => {
    const raw =
      process.env.TRON_PAYER_MIN_TRX?.trim() || process.env.TRON_GAS_PAYER_MIN_TRX?.trim();
    const n = raw ? Number(raw) : 5000;
    return Number.isFinite(n) && n > 0 ? n : 5000;
  })(),
  /**
   * When true, sovereign path calls getAccount before broadcast to enforce tronGasPayerMinTrx (extra RPC).
   * Default false keeps latency lower for the sub-2s path; enable in production if you want the guardrail.
   */
  sovereignFeeEnforcePayerTrx: process.env.SOVEREIGN_FEE_ENFORCE_PAYER_TRX?.trim() === "1",
};
