export type UsageSyncPhase = "initializing" | "refreshing" | "ready" | "error";

export type UsageSyncSnapshot = {
  phase: UsageSyncPhase;
  running: boolean;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
};

type SyncCoordinatorOptions = {
  completedAt: string | null;
  persistCompletedAt: (completedAt: string) => void | Promise<void>;
  now?: () => string;
};

export function createSyncCoordinator({
  completedAt: initialCompletedAt,
  persistCompletedAt,
  now = () => new Date().toISOString(),
}: SyncCoordinatorOptions) {
  let completedAt = initialCompletedAt;
  let startedAt: string | null = null;
  let error: string | null = null;
  let running: Promise<string> | null = null;

  const snapshot = (): UsageSyncSnapshot => {
    if (running) {
      return {
        phase: completedAt ? "refreshing" : "initializing",
        running: true,
        startedAt,
        completedAt,
        error: null,
      };
    }

    if (!completedAt && error) {
      return { phase: "error", running: false, startedAt: null, completedAt: null, error };
    }

    return {
      phase: completedAt ? "ready" : "initializing",
      running: false,
      startedAt: null,
      completedAt,
      error,
    };
  };

  const run = (collect: () => Promise<string>) => {
    if (running) return running;

    startedAt = now();
    error = null;
    running = (async () => {
      try {
        const nextCompletedAt = await collect();
        await persistCompletedAt(nextCompletedAt);
        completedAt = nextCompletedAt;
        return nextCompletedAt;
      } catch (reason) {
        error = reason instanceof Error && reason.message
          ? reason.message
          : "Usage sync failed.";
        throw reason;
      } finally {
        running = null;
        startedAt = null;
      }
    })();

    return running;
  };

  return { run, snapshot };
}
