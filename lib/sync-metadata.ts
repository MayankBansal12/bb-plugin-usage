import type { BbPluginApi } from "@bb/plugin-sdk";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

const LAST_COMPLETED_SYNC_KEY = "last_completed_sync_at";

export const syncMetadataMigration = `
CREATE TABLE IF NOT EXISTS usage_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO usage_metadata (key, value)
SELECT 'last_completed_sync_at', MAX(COALESCE(last_success_at, last_attempt_at))
FROM usage_sync_state
HAVING COUNT(*) > 0;`;

export function readLastCompletedSyncAt(db: Database) {
  const stored = db.prepare("SELECT value FROM usage_metadata WHERE key=?")
    .get(LAST_COMPLETED_SYNC_KEY) as { value: string } | undefined;
  return stored?.value ?? null;
}

export function persistLastCompletedSyncAt(db: Database, completedAt: string) {
  db.prepare(`INSERT INTO usage_metadata (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
    .run(LAST_COMPLETED_SYNC_KEY, completedAt);
}
