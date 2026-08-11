import { createHash } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { parseClaude, parseCodex, parseGrok, PRICING_REVISION, PRICING_VERSION, type ProviderId, type UsageRecord } from "./collectors";

const usageRecordSchema = z.object({
  day: z.string(), providerId: z.string(), providerName: z.string(), machineId: z.string(), machineName: z.string(), model: z.string(),
  costUsd: z.number(), cacheSavingsUsd: z.number(), processedTokens: z.number().int(), cachedInputTokens: z.number().int(), cacheWriteTokens: z.number().int(), uncachedInputTokens: z.number().int(), outputTokens: z.number().int(),
});
const filterOptionSchema = z.object({ id: z.string(), name: z.string(), status: z.string().optional() });
const sourceStateSchema = z.object({
  machineId: z.string(), providerId: z.string(), status: z.string(), lastAttemptAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(), recordCount: z.number().int(), error: z.string().nullable(),
});
type DashboardRecord = z.infer<typeof usageRecordSchema>;
type SourceState = z.infer<typeof sourceStateSchema>;

export const rpcContract = defineRpcContract({
  dashboard: { input: z.null(), output: z.object({
    mode: z.literal("live"), generatedAt: z.string(), lastSyncedAt: z.string().nullable(), pricingVersion: z.string(),
    machines: z.array(filterOptionSchema), providers: z.array(filterOptionSchema), records: z.array(usageRecordSchema), sources: z.array(sourceStateSchema), notice: z.string(),
  }) },
  sync: { input: z.null(), output: z.object({ ok: z.literal(true) }) },
});

type Database = ReturnType<BbPluginApi["storage"]["database"]>;
const PROVIDERS = [
  { id: "codex", name: "Codex" }, { id: "claude", name: "Claude Code" }, { id: "grok", name: "Grok Agent" },
] as const;

const migration = `
CREATE TABLE IF NOT EXISTS usage_events (
  event_key TEXT PRIMARY KEY, timestamp TEXT NOT NULL, day TEXT NOT NULL, provider_id TEXT NOT NULL, provider_name TEXT NOT NULL,
  model TEXT NOT NULL, cost_usd REAL NOT NULL, cache_savings_usd REAL NOT NULL, processed_tokens INTEGER NOT NULL,
  cached_input_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, uncached_input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_events_day_idx ON usage_events(day);
CREATE INDEX IF NOT EXISTS usage_events_provider_idx ON usage_events(provider_id, day);
CREATE TABLE IF NOT EXISTS usage_sources (
  source_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, machine_name TEXT NOT NULL, provider_id TEXT NOT NULL,
  root_reference TEXT NOT NULL, content_sha TEXT NOT NULL, last_seen_generation TEXT NOT NULL, last_success_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_sources_machine_idx ON usage_sources(machine_id, provider_id);
CREATE TABLE IF NOT EXISTS usage_event_sources (
  event_key TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY (event_key, source_id)
);
CREATE INDEX IF NOT EXISTS usage_event_sources_source_idx ON usage_event_sources(source_id);
CREATE TABLE IF NOT EXISTS usage_sync_state (
  machine_id TEXT NOT NULL, provider_id TEXT NOT NULL, status TEXT NOT NULL, last_attempt_at TEXT,
  last_success_at TEXT, record_count INTEGER NOT NULL DEFAULT 0, error TEXT, PRIMARY KEY (machine_id, provider_id)
);`;

const pricingMigration = `ALTER TABLE usage_sources ADD COLUMN pricing_version TEXT;`;

function opaqueId(...parts: string[]) {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function countForMachine(db: Database, machineId: string, providerId: ProviderId) {
  return (db.prepare(`SELECT COUNT(DISTINCT es.event_key) AS count FROM usage_event_sources es
    JOIN usage_sources s ON s.source_id=es.source_id WHERE s.machine_id=? AND s.provider_id=?`)
    .get(machineId, providerId) as { count: number }).count;
}

function upsertState(db: Database, machineId: string, providerId: ProviderId, status: string, recordCount: number, error: string | null, successful: boolean) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO usage_sync_state (machine_id, provider_id, status, last_attempt_at, last_success_at, record_count, error)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(machine_id, provider_id) DO UPDATE SET
    status=excluded.status, last_attempt_at=excluded.last_attempt_at,
    last_success_at=COALESCE(excluded.last_success_at, usage_sync_state.last_success_at),
    record_count=excluded.record_count, error=excluded.error`)
    .run(machineId, providerId, status, now, successful ? now : null, recordCount, error);
}

function upsertSourceEvents(db: Database, source: { id: string; rootReference: string; sha256: string; generation: string }, machine: { id: string; name: string }, providerId: ProviderId, records: UsageRecord[]) {
  const insertEvent = db.prepare(`INSERT INTO usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_key) DO UPDATE SET timestamp=excluded.timestamp, day=excluded.day, provider_id=excluded.provider_id,
    provider_name=excluded.provider_name, model=excluded.model, cost_usd=excluded.cost_usd,
    cache_savings_usd=excluded.cache_savings_usd, processed_tokens=excluded.processed_tokens,
    cached_input_tokens=excluded.cached_input_tokens, cache_write_tokens=excluded.cache_write_tokens,
    uncached_input_tokens=excluded.uncached_input_tokens, output_tokens=excluded.output_tokens`);
  const insertMapping = db.prepare("INSERT OR IGNORE INTO usage_event_sources (event_key, source_id) VALUES (?, ?)");

  db.transaction(() => {
    db.prepare(`INSERT INTO usage_sources (source_id, machine_id, machine_name, provider_id, root_reference, content_sha, last_seen_generation, last_success_at, pricing_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET
      machine_name=excluded.machine_name, root_reference=excluded.root_reference, content_sha=excluded.content_sha,
      last_seen_generation=excluded.last_seen_generation, last_success_at=excluded.last_success_at, pricing_version=excluded.pricing_version`)
      .run(source.id, machine.id, machine.name, providerId, source.rootReference, source.sha256, source.generation, new Date().toISOString(), PRICING_REVISION);
    db.prepare("DELETE FROM usage_event_sources WHERE source_id=?").run(source.id);
    for (const row of records) {
      insertEvent.run(row.eventKey, row.timestamp, row.day, row.providerId, row.providerName, row.model, row.costUsd, row.cacheSavingsUsd, row.processedTokens, row.cachedInputTokens, row.cacheWriteTokens, row.uncachedInputTokens, row.outputTokens);
      insertMapping.run(row.eventKey, source.id);
    }
    db.prepare("DELETE FROM usage_events WHERE event_key NOT IN (SELECT event_key FROM usage_event_sources)").run();
  })();
}

function markSourceSeen(db: Database, sourceId: string, generation: string) {
  db.prepare("UPDATE usage_sources SET last_seen_generation=? WHERE source_id=?").run(generation, sourceId);
}

function reconcileSources(db: Database, machineId: string, providerId: ProviderId, generation: string) {
  db.transaction(() => {
    const stale = db.prepare("SELECT source_id id FROM usage_sources WHERE machine_id=? AND provider_id=? AND last_seen_generation<>?")
      .all(machineId, providerId, generation) as Array<{ id: string }>;
    const removeMappings = db.prepare("DELETE FROM usage_event_sources WHERE source_id=?");
    const removeSource = db.prepare("DELETE FROM usage_sources WHERE source_id=?");
    for (const source of stale) { removeMappings.run(source.id); removeSource.run(source.id); }
    db.prepare("DELETE FROM usage_events WHERE event_key NOT IN (SELECT event_key FROM usage_event_sources)").run();
  })();
}

function reconcileMachines(db: Database, machineIds: string[]) {
  if (machineIds.length === 0) return;
  const placeholders = machineIds.map(() => "?").join(",");
  db.transaction(() => {
    const stale = db.prepare(`SELECT source_id id FROM usage_sources WHERE machine_id NOT IN (${placeholders})`).all(...machineIds) as Array<{ id: string }>;
    for (const source of stale) db.prepare("DELETE FROM usage_event_sources WHERE source_id=?").run(source.id);
    db.prepare(`DELETE FROM usage_sources WHERE machine_id NOT IN (${placeholders})`).run(...machineIds);
    db.prepare(`DELETE FROM usage_sync_state WHERE machine_id NOT IN (${placeholders})`).run(...machineIds);
    db.prepare("DELETE FROM usage_events WHERE event_key NOT IN (SELECT event_key FROM usage_event_sources)").run();
  })();
}

type DiscoveredSource = { path: string; id: string; rootReference: string };
type Discovery = { sources: DiscoveredSource[]; truncated: boolean };

async function discoverSources(bb: BbPluginApi, hostId: string, home: string, providerId: ProviderId): Promise<Discovery> {
  const root = providerId === "codex" ? `${home}/.codex/sessions` : providerId === "claude" ? `${home}/.claude/projects` : `${home}/.grok/logs`;
  if (providerId === "grok") {
    const path = `${root}/unified.jsonl`;
    return { sources: [{ path, id: opaqueId(hostId, providerId, path), rootReference: opaqueId(root) }], truncated: false };
  }
  const result = await bb.sdk.files.list({ hostId, path: root, query: providerId === "codex" ? "rollout-" : ".jsonl", limit: 5000 });
  const sources = result.files
    .map((file) => file.path.startsWith("/") ? file.path : `${root}/${file.path}`)
    .filter((path) => path.endsWith(".jsonl"))
    .map((path) => ({ path, id: opaqueId(hostId, providerId, path), rootReference: opaqueId(root) }));
  return { sources, truncated: result.truncated };
}

async function syncProvider(bb: BbPluginApi, db: Database, machine: { id: string; name: string }, home: string, providerId: ProviderId) {
  const generation = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const discovery = await discoverSources(bb, machine.id, home, providerId);
    let changed = 0;
    let readFailures = 0;
    for (const source of discovery.sources) {
      let file;
      try { file = await bb.sdk.files.read({ hostId: machine.id, path: source.path }); } catch { readFailures += 1; continue; }
      if (file.contentEncoding !== "utf8") { readFailures += 1; continue; }
      const prior = db.prepare("SELECT content_sha sha256, pricing_version pricingVersion FROM usage_sources WHERE source_id=?").get(source.id) as { sha256?: string; pricingVersion?: string } | undefined;
      if (prior?.sha256 === file.sha256 && prior.pricingVersion === PRICING_REVISION) { markSourceSeen(db, source.id, generation); continue; }
      const context = { machineId: machine.id, machineName: machine.name };
      const records = providerId === "codex" ? parseCodex(file.content, context) : providerId === "claude" ? parseClaude(file.content, context) : parseGrok(file.content, context);
      upsertSourceEvents(db, { id: source.id, rootReference: source.rootReference, sha256: file.sha256, generation }, machine, providerId, records);
      changed += records.length;
    }

    const complete = !discovery.truncated && readFailures === 0;
    if (complete) reconcileSources(db, machine.id, providerId, generation);
    const count = countForMachine(db, machine.id, providerId);
    const status = !complete ? "partial" : count > 0 ? "ready" : "no-data";
    const error = discovery.truncated ? "File limit reached; history is incomplete." : readFailures > 0 ? `${readFailures} source file${readFailures === 1 ? "" : "s"} could not be read.` : null;
    upsertState(db, machine.id, providerId, status, count, error, complete);
    bb.log.info(`${machine.name}/${providerId}: ${count} records (${changed} refreshed, ${status})`);
  } catch {
    const count = countForMachine(db, machine.id, providerId);
    upsertState(db, machine.id, providerId, "unavailable", count, "Source discovery failed.", false);
    bb.log.warn(`${machine.name}/${providerId}: source discovery failed`);
  }
}

function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [migration, pricingMigration]);
  let running: Promise<string> | null = null;

  const syncAll = () => {
    if (running) return running;
    running = (async () => {
      const machines = await bb.sdk.hosts.list();
      reconcileMachines(db, machines.map((machine) => machine.id));
      for (const machine of machines) {
        if (machine.status !== "connected") {
          for (const provider of PROVIDERS) upsertState(db, machine.id, provider.id, "offline", countForMachine(db, machine.id, provider.id), null, false);
          continue;
        }
        try {
          const home = (await bb.sdk.hosts.directory({ hostId: machine.id })).directory;
          for (const provider of PROVIDERS) await syncProvider(bb, db, machine, home, provider.id);
        } catch {
          for (const provider of PROVIDERS) upsertState(db, machine.id, provider.id, "unavailable", countForMachine(db, machine.id, provider.id), "Machine home directory could not be resolved.", false);
        }
      }
      const completedAt = new Date().toISOString();
      bb.realtime.publish("usage-updated", { completedAt });
      return completedAt;
    })().finally(() => { running = null; });
    return running;
  };

  bb.rpc.register(rpcContract, {
    async dashboard() {
      const machines = (await bb.sdk.hosts.list()).map((host) => ({ id: host.id, name: host.name, status: host.status }));
      const machineNames = new Map(machines.map((machine) => [machine.id, machine.name]));
      const rows = db.prepare(`WITH canonical AS (
          SELECT e.*, MIN(s.machine_id) machine_id FROM usage_events e
          JOIN usage_event_sources es ON es.event_key=e.event_key JOIN usage_sources s ON s.source_id=es.source_id
          GROUP BY e.event_key
        ) SELECT day, provider_id providerId, provider_name providerName, machine_id machineId, model,
        SUM(cost_usd) costUsd, SUM(cache_savings_usd) cacheSavingsUsd, SUM(processed_tokens) processedTokens,
        SUM(cached_input_tokens) cachedInputTokens, SUM(cache_write_tokens) cacheWriteTokens,
        SUM(uncached_input_tokens) uncachedInputTokens, SUM(output_tokens) outputTokens
        FROM canonical WHERE day >= date('now', '-365 days')
        AND NOT (provider_id='claude' AND model='<synthetic>' AND processed_tokens=0)
        GROUP BY day, provider_id, machine_id, model ORDER BY day`).all() as Array<Omit<DashboardRecord, "machineName">>;
      const records = rows.map((row) => ({ ...row, machineName: machineNames.get(row.machineId) ?? "Unknown machine" }));
      const sources = db.prepare(`SELECT machine_id machineId, provider_id providerId, status, last_attempt_at lastAttemptAt,
        last_success_at lastSuccessAt, record_count recordCount, error FROM usage_sync_state ORDER BY machine_id, provider_id`).all() as SourceState[];
      const last = db.prepare("SELECT MAX(last_success_at) AS value FROM usage_sync_state").get() as { value: string | null };
      return { mode: "live" as const, generatedAt: new Date().toISOString(), lastSyncedAt: last.value, pricingVersion: PRICING_VERSION,
        machines, providers: [...PROVIDERS], records, sources,
        notice: "Local metadata only: prompts and message content are never stored. Dollar values are standard API-equivalent estimates, not subscription charges." };
    },
    sync() {
      void syncAll().catch((error) => bb.log.error(`Usage sync failed: ${String(error)}`));
      return { ok: true as const };
    },
  });

  bb.background.service("usage-collector", {
    async start(signal) {
      while (!signal.aborted) {
        try { await syncAll(); } catch (error) { bb.log.error(`Usage sync failed: ${String(error)}`); }
        await abortableDelay(15 * 60_000, signal);
      }
    },
  });
}
