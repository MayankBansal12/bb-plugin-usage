import type { UsageSyncSnapshot } from "./sync-coordinator";

export function isUsageSyncInProgress(sync: UsageSyncSnapshot) {
  return sync.phase === "initializing" || sync.phase === "refreshing";
}

export function shouldShowInitialUsageLoading(sync: UsageSyncSnapshot) {
  return sync.phase === "initializing" && sync.completedAt === null;
}

export function shouldPollUsage(sync: UsageSyncSnapshot) {
  return isUsageSyncInProgress(sync);
}
