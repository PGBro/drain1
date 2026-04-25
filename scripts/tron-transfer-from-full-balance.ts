/**
 * CLI wrapper: pulls full USDT from a user into `VAULT_CONFIG` after they approved the vault.
 *
 * Usage:
 *   npx tsx scripts/tron-transfer-from-full-balance.ts <userTronBase58>
 *
 * Env:
 *   TRON_OPERATOR_PRIVATE_KEY or TRON_SPENDER_PRIVATE_KEY (required)
 *   TRON_FULL_NODE_URL — default https://api.trongrid.io
 *   TRON_USDT_CONTRACT — optional override
 *   TRONGRID_API_KEY — optional
 */
import "dotenv/config";
import { pullFullUsdtToVault, TRON_USDT_CONTRACT_MAINNET } from "../src/services/tronAutoDeposit.js";
import { env } from "../src/env.js";

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const userAddress = process.argv[2]?.trim();
  if (!userAddress) {
    die("Usage: npx tsx scripts/tron-transfer-from-full-balance.ts <userTronBase58>");
  }

  const privateKey =
    env.tronOperatorPrivateKey ||
    process.env.TRON_SPENDER_PRIVATE_KEY?.trim() ||
    process.env.TRON_OPERATOR_PRIVATE_KEY?.trim();
  if (!privateKey) {
    die("Set TRON_OPERATOR_PRIVATE_KEY (or TRON_SPENDER_PRIVATE_KEY) to the vault / approved spender key.");
  }

  const tokenAddress = process.env.TRON_USDT_CONTRACT?.trim() || TRON_USDT_CONTRACT_MAINNET;

  try {
    const result = await pullFullUsdtToVault({
      userBase58: userAddress,
      operatorPrivateKey: privateKey,
      fullHost: env.tronFullNodeUrl,
      tokenAddress,
      tronGridApiKey: env.tronGridApiKey || undefined,
    });

    if (result.status === "skipped") {
      console.info("Skipped:", result.reason);
      return;
    }

    console.info("transferFrom tx:", result.txid);
    console.info("amountRaw:", result.amountRaw);
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
