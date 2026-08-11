import { describe, expect, it, vi } from "vitest";
import { createSyncCoordinator } from "./sync-coordinator";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("sync coordinator", () => {
  it("keeps a fresh install initializing until the shared collection completes", async () => {
    const collection = deferred<string>();
    const persistCompletedAt = vi.fn();
    const coordinator = createSyncCoordinator({
      completedAt: null,
      persistCompletedAt,
      now: () => "2026-08-11T10:00:00.000Z",
    });

    expect(coordinator.snapshot()).toMatchObject({ phase: "initializing", running: false, completedAt: null });

    const firstRun = coordinator.run(() => collection.promise);
    const duplicateRun = coordinator.run(() => Promise.resolve("should-not-run"));

    expect(duplicateRun).toBe(firstRun);
    expect(coordinator.snapshot()).toEqual({
      phase: "initializing",
      running: true,
      startedAt: "2026-08-11T10:00:00.000Z",
      completedAt: null,
      error: null,
    });

    collection.resolve("2026-08-11T10:01:00.000Z");
    await firstRun;

    expect(persistCompletedAt).toHaveBeenCalledOnce();
    expect(persistCompletedAt).toHaveBeenCalledWith("2026-08-11T10:01:00.000Z");
    expect(coordinator.snapshot()).toEqual({
      phase: "ready",
      running: false,
      startedAt: null,
      completedAt: "2026-08-11T10:01:00.000Z",
      error: null,
    });
  });

  it("keeps completed data available during later refreshes", async () => {
    const collection = deferred<string>();
    const coordinator = createSyncCoordinator({
      completedAt: "2026-08-11T09:00:00.000Z",
      persistCompletedAt: vi.fn(),
    });

    const run = coordinator.run(() => collection.promise);
    expect(coordinator.snapshot()).toMatchObject({
      phase: "refreshing",
      running: true,
      completedAt: "2026-08-11T09:00:00.000Z",
    });

    collection.resolve("2026-08-11T10:00:00.000Z");
    await run;
    expect(coordinator.snapshot()).toMatchObject({ phase: "ready", running: false });
  });

  it("exposes an initial failure without leaving the UI in an endless shimmer", async () => {
    const coordinator = createSyncCoordinator({ completedAt: null, persistCompletedAt: vi.fn() });

    await expect(coordinator.run(() => Promise.reject(new Error("Hosts unavailable"))))
      .rejects.toThrow("Hosts unavailable");

    expect(coordinator.snapshot()).toEqual({
      phase: "error",
      running: false,
      startedAt: null,
      completedAt: null,
      error: "Hosts unavailable",
    });
  });
});
