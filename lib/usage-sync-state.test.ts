import { describe, expect, it } from "vitest";
import type { UsageSyncSnapshot } from "./sync-coordinator";
import { isUsageSyncInProgress, shouldPollUsage, shouldShowInitialUsageLoading } from "./usage-sync-state";

function sync(phase: UsageSyncSnapshot["phase"], completedAt: string | null): UsageSyncSnapshot {
  return { phase, completedAt, running: phase === "initializing" || phase === "refreshing", startedAt: null, error: null };
}

describe("usage sync view state", () => {
  it("shows and polls the shimmer only for unfinished initial collection", () => {
    const initializing = sync("initializing", null);
    expect(shouldShowInitialUsageLoading(initializing)).toBe(true);
    expect(shouldPollUsage(initializing)).toBe(true);
    expect(isUsageSyncInProgress(initializing)).toBe(true);
  });

  it("polls a refresh while keeping completed dashboard data visible", () => {
    const refreshing = sync("refreshing", "2026-08-11T10:00:00.000Z");
    expect(shouldShowInitialUsageLoading(refreshing)).toBe(false);
    expect(shouldPollUsage(refreshing)).toBe(true);
  });

  it("stops polling after completion or failure", () => {
    expect(shouldPollUsage(sync("ready", "2026-08-11T10:00:00.000Z"))).toBe(false);
    expect(shouldPollUsage(sync("error", null))).toBe(false);
  });
});
