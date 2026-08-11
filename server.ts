import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import {
  parseClaude, parseCodex, parseGrok, parseOpenCode, parsePi,
  PRICING_REVISION, PRICING_VERSION, type AgentId, type UsageRecord,
} from "./collectors";
import { createSyncCoordinator } from "./lib/sync-coordinator";
import { persistLastCompletedSyncAt, readLastCompletedSyncAt, syncMetadataMigration } from "./lib/sync-metadata";

const usageRecordSchema = z.object({
  day: z.string(), agentId: z.string(), agentName: z.string(),
  modelProviderId: z.string(), modelProviderName: z.string(),
  machineId: z.string(), machineName: z.string(), model: z.string(),
  costUsd: z.number(), loggedCostUsd: z.number().nullable(), pricingStatus: z.string(),
  cacheSavingsUsd: z.number(), processedTokens: z.number().int(), cachedInputTokens: z.number().int(),
  cacheWriteTokens: z.number().int(), uncachedInputTokens: z.number().int(), outputTokens: z.number().int(),
});
const filterOptionSchema = z.object({ id: z.string(), name: z.string(), status: z.string().optional() });
const sourceStateSchema = z.object({
  machineId: z.string(), agentId: z.string(), status: z.string(), lastAttemptAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(), recordCount: z.number().int(), error: z.string().nullable(),
});
const syncStateSchema = z.object({
  phase: z.enum(["initializing", "refreshing", "ready", "error"]), running: z.boolean(),
  startedAt: z.string().nullable(), completedAt: z.string().nullable(), error: z.string().nullable(),
});
const providerLimitWindowSchema = z.object({
  label: z.string(), usedPercent: z.number(), resetsAt: z.string().nullable(),
  cost: z.object({ usedUsdCents: z.number(), limitUsdCents: z.number() }).optional(),
});
const providerLimitSchema = z.object({
  machineId: z.string(), machineName: z.string(), providerId: z.string(), providerName: z.string(),
  planLabel: z.string().nullable(), windows: z.array(providerLimitWindowSchema),
});
type DashboardRecord = z.infer<typeof usageRecordSchema>;
type SourceState = z.infer<typeof sourceStateSchema>;

export const rpcContract = defineRpcContract({
  dashboard: { input: z.null(), output: z.object({
    mode: z.literal("live"), generatedAt: z.string(), lastSyncedAt: z.string().nullable(), pricingVersion: z.string(),
    machines: z.array(filterOptionSchema), agents: z.array(filterOptionSchema), modelProviders: z.array(filterOptionSchema),
    records: z.array(usageRecordSchema), sources: z.array(sourceStateSchema), providerLimits: z.array(providerLimitSchema),
    sync: syncStateSchema, notice: z.string(),
  }) },
  sync: { input: z.null(), output: z.object({ ok: z.literal(true) }) },
});

type Database = ReturnType<BbPluginApi["storage"]["database"]>;
type Machine = { id: string; name: string };
type CollectorSettings = { piSessionRoots: string; openCodeDatabasePath: string };

const AGENTS = [
  { id: "codex", name: "Codex" },
  { id: "claude", name: "Claude Code" },
  { id: "grok", name: "Grok Agent" },
  { id: "opencode", name: "OpenCode" },
  { id: "pi", name: "Pi" },
] as const satisfies ReadonlyArray<{ id: AgentId; name: string }>;

const LIMIT_PROVIDERS = [
  { key: "codex", id: "codex", name: "Codex" },
  { key: "claudeCode", id: "claude", name: "Claude Code" },
  { key: "cursor", id: "cursor", name: "Cursor" },
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
const multiAgentMigration = `
ALTER TABLE usage_events ADD COLUMN model_provider_id TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE usage_events ADD COLUMN model_provider_name TEXT NOT NULL DEFAULT 'Unknown';
ALTER TABLE usage_events ADD COLUMN logged_cost_usd REAL;
ALTER TABLE usage_events ADD COLUMN pricing_status TEXT NOT NULL DEFAULT 'unknown';
UPDATE usage_events SET
  model_provider_id=CASE provider_id WHEN 'codex' THEN 'openai' WHEN 'claude' THEN 'anthropic' WHEN 'grok' THEN 'xai' ELSE 'unknown' END,
  model_provider_name=CASE provider_id WHEN 'codex' THEN 'OpenAI' WHEN 'claude' THEN 'Anthropic' WHEN 'grok' THEN 'xAI' ELSE 'Unknown' END,
  pricing_status='models-dev-alias';
CREATE INDEX IF NOT EXISTS usage_events_model_provider_idx ON usage_events(model_provider_id, day);
`;

function opaqueId(...parts: string[]) {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 300) || "Unknown error.";
}

function isNotFound(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return /not found|enoent|does not exist|no such file|missing/.test(message);
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function expandHome(path: string, home: string) {
  const trimmed = path.trim();
  if (!trimmed) return "";
  return trimmed === "~" ? home : trimmed.startsWith("~/") ? `${home}/${trimmed.slice(2)}` : trimmed;
}

function configuredRoots(value: string, home: string) {
  return [...new Set(value.split(/[;\n]/).map((part) => expandHome(part, home)).filter(Boolean))];
}

function countForMachine(db: Database, machineId: string, agentId: AgentId) {
  return (db.prepare(`SELECT COUNT(DISTINCT es.event_key) AS count FROM usage_event_sources es
    JOIN usage_sources s ON s.source_id=es.source_id WHERE s.machine_id=? AND s.provider_id=?`)
    .get(machineId, agentId) as { count: number }).count;
}

function upsertState(db: Database, machineId: string, agentId: AgentId, status: string, recordCount: number, error: string | null, successful: boolean) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO usage_sync_state (machine_id, provider_id, status, last_attempt_at, last_success_at, record_count, error)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(machine_id, provider_id) DO UPDATE SET
    status=excluded.status, last_attempt_at=excluded.last_attempt_at,
    last_success_at=COALESCE(excluded.last_success_at, usage_sync_state.last_success_at),
    record_count=excluded.record_count, error=excluded.error`)
    .run(machineId, agentId, status, now, successful ? now : null, recordCount, error);
}

function upsertSourceEvents(db: Database, source: { id: string; rootReference: string; sha256: string; generation: string }, machine: Machine, agentId: AgentId, records: UsageRecord[]) {
  const insertEvent = db.prepare(`INSERT INTO usage_events (
      event_key, timestamp, day, provider_id, provider_name, model, cost_usd, cache_savings_usd,
      processed_tokens, cached_input_tokens, cache_write_tokens, uncached_input_tokens, output_tokens,
      model_provider_id, model_provider_name, logged_cost_usd, pricing_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_key) DO UPDATE SET timestamp=excluded.timestamp, day=excluded.day, provider_id=excluded.provider_id,
    provider_name=excluded.provider_name, model=excluded.model, cost_usd=excluded.cost_usd,
    cache_savings_usd=excluded.cache_savings_usd, processed_tokens=excluded.processed_tokens,
    cached_input_tokens=excluded.cached_input_tokens, cache_write_tokens=excluded.cache_write_tokens,
    uncached_input_tokens=excluded.uncached_input_tokens, output_tokens=excluded.output_tokens,
    model_provider_id=excluded.model_provider_id, model_provider_name=excluded.model_provider_name,
    logged_cost_usd=excluded.logged_cost_usd, pricing_status=excluded.pricing_status`);
  const insertMapping = db.prepare("INSERT OR IGNORE INTO usage_event_sources (event_key, source_id) VALUES (?, ?)");

  db.transaction(() => {
    db.prepare(`INSERT INTO usage_sources (source_id, machine_id, machine_name, provider_id, root_reference, content_sha, last_seen_generation, last_success_at, pricing_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET
      machine_name=excluded.machine_name, root_reference=excluded.root_reference, content_sha=excluded.content_sha,
      last_seen_generation=excluded.last_seen_generation, last_success_at=excluded.last_success_at, pricing_version=excluded.pricing_version`)
      .run(source.id, machine.id, machine.name, agentId, source.rootReference, source.sha256, source.generation, new Date().toISOString(), PRICING_REVISION);
    db.prepare("DELETE FROM usage_event_sources WHERE source_id=?").run(source.id);
    for (const row of records) {
      insertEvent.run(
        row.eventKey, row.timestamp, row.day, row.agentId, row.agentName, row.model, row.costUsd, row.cacheSavingsUsd,
        row.processedTokens, row.cachedInputTokens, row.cacheWriteTokens, row.uncachedInputTokens, row.outputTokens,
        row.modelProviderId, row.modelProviderName, row.loggedCostUsd, row.pricingStatus,
      );
      insertMapping.run(row.eventKey, source.id);
    }
    db.prepare("DELETE FROM usage_events WHERE event_key NOT IN (SELECT event_key FROM usage_event_sources)").run();
  })();
}

function markSourceSeen(db: Database, sourceId: string, generation: string) {
  db.prepare("UPDATE usage_sources SET last_seen_generation=? WHERE source_id=?").run(generation, sourceId);
}

function reconcileSources(db: Database, machineId: string, agentId: AgentId, generation: string) {
  db.transaction(() => {
    const stale = db.prepare("SELECT source_id id FROM usage_sources WHERE machine_id=? AND provider_id=? AND last_seen_generation<>?")
      .all(machineId, agentId, generation) as Array<{ id: string }>;
    for (const source of stale) {
      db.prepare("DELETE FROM usage_event_sources WHERE source_id=?").run(source.id);
      db.prepare("DELETE FROM usage_sources WHERE source_id=?").run(source.id);
    }
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

async function discoverJsonSources(
  bb: BbPluginApi,
  hostId: string,
  home: string,
  agentId: Exclude<AgentId, "opencode">,
  settings: CollectorSettings,
): Promise<Discovery> {
  const roots = agentId === "codex" ? [`${home}/.codex/sessions`]
    : agentId === "claude" ? [`${home}/.claude/projects`]
    : agentId === "grok" ? [`${home}/.grok/logs`]
    : [`${home}/.pi/agent/sessions`, ...configuredRoots(settings.piSessionRoots, home)];
  const sources: DiscoveredSource[] = [];
  let truncated = false;

  for (const root of [...new Set(roots)]) {
    let result;
    try {
      result = await bb.sdk.files.list({
        hostId,
        path: root,
        query: agentId === "codex" ? "rollout-" : agentId === "grok" ? "unified.jsonl" : ".jsonl",
        limit: 5000,
      });
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    truncated ||= result.truncated;
    for (const file of result.files) {
      const path = file.path.startsWith("/") ? file.path : `${root}/${file.path}`;
      if (!path.endsWith(".jsonl")) continue;
      if (agentId === "grok" && !path.endsWith("/unified.jsonl")) continue;
      sources.push({ path, id: opaqueId(hostId, agentId, path), rootReference: opaqueId(root) });
    }
  }
  return { sources: [...new Map(sources.map((source) => [source.id, source])).values()], truncated };
}

function parserFor(agentId: Exclude<AgentId, "opencode">) {
  return agentId === "codex" ? parseCodex : agentId === "claude" ? parseClaude : agentId === "grok" ? parseGrok : parsePi;
}

async function syncJsonAgent(
  bb: BbPluginApi,
  db: Database,
  machine: Machine,
  home: string,
  agentId: Exclude<AgentId, "opencode">,
  settings: CollectorSettings,
) {
  const generation = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const discovery = await discoverJsonSources(bb, machine.id, home, agentId, settings);
    let refreshed = 0;
    let readFailures = 0;
    let parseFailures = 0;
    let lastError: string | null = null;
    for (const source of discovery.sources) {
      let file;
      try {
        file = await bb.sdk.files.read({ hostId: machine.id, path: source.path });
      } catch (error) {
        if (isNotFound(error)) continue;
        readFailures += 1;
        lastError = errorMessage(error);
        continue;
      }
      if (file.contentEncoding !== "utf8") {
        readFailures += 1;
        lastError = "A usage log was not UTF-8 text.";
        continue;
      }
      const prior = db.prepare("SELECT content_sha sha256, pricing_version pricingVersion FROM usage_sources WHERE source_id=?")
        .get(source.id) as { sha256?: string; pricingVersion?: string } | undefined;
      if (prior?.sha256 === file.sha256 && prior.pricingVersion === PRICING_REVISION) {
        markSourceSeen(db, source.id, generation);
        continue;
      }
      try {
        const records = parserFor(agentId)(file.content, { machineId: machine.id, machineName: machine.name });
        upsertSourceEvents(db, { id: source.id, rootReference: source.rootReference, sha256: file.sha256, generation }, machine, agentId, records);
        refreshed += records.length;
      } catch (error) {
        parseFailures += 1;
        lastError = errorMessage(error);
      }
    }

    const failureCount = readFailures + parseFailures;
    const complete = !discovery.truncated && failureCount === 0;
    if (complete) reconcileSources(db, machine.id, agentId, generation);
    const recordCount = countForMachine(db, machine.id, agentId);
    const status = !complete ? "partial" : recordCount > 0 ? "ready" : "no-data";
    const error = discovery.truncated ? "File discovery reached the 5,000-file safety limit."
      : failureCount > 0 ? `${failureCount} source file${failureCount === 1 ? "" : "s"} could not be collected${lastError ? `: ${lastError}` : "."}`
      : null;
    upsertState(db, machine.id, agentId, status, recordCount, error, complete);
    bb.log.info(`${machine.name}/${agentId}: ${recordCount} records (${refreshed} refreshed, ${status})`);
  } catch (error) {
    const recordCount = countForMachine(db, machine.id, agentId);
    const message = `Source discovery failed: ${errorMessage(error)}`;
    upsertState(db, machine.id, agentId, "unavailable", recordCount, message, false);
    bb.log.warn(`${machine.name}/${agentId}: ${message}`);
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function runHostCommand(bb: BbPluginApi, machine: Machine, command: string) {
  const terminal = await bb.sdk.terminals.create({
    scope: { kind: "host_path", hostId: machine.id, cwd: null },
    cols: 120,
    rows: 24,
    title: "Usage: OpenCode scan",
    start: { mode: "command", command },
  });
  try {
    const deadline = Date.now() + 30_000;
    let state = terminal;
    while (state.status === "starting" || state.status === "running" || state.status === "disconnected") {
      if (Date.now() >= deadline) throw new Error("OpenCode metadata query timed out after 30 seconds.");
      await delay(200);
      state = await bb.sdk.terminals.get({ terminalId: terminal.id });
    }
    const output = await bb.sdk.terminals.output({ terminalId: terminal.id, tailBytes: 900_000, limitChunks: 4000 });
    if (output.truncated) throw new Error("OpenCode metadata query exceeded the 900 KB output limit.");
    const text = output.chunks.sort((a, b) => a.seq - b.seq)
      .map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString("utf8")).join("");
    if ((state.exitCode ?? 1) !== 0) {
      const diagnostic = text.match(/__BB_USAGE_ERROR__:(.+)/)?.[1]?.trim();
      throw new Error(diagnostic || `OpenCode metadata query exited with code ${state.exitCode ?? "unknown"}.`);
    }
    return text;
  } finally {
    try { await bb.sdk.terminals.close({ terminalId: terminal.id, mode: "force" }); } catch { /* already closed by the host */ }
  }
}

function openCodeCommand(databasePath: string) {
  const sql = `
SELECT
  date(time_created / 1000, 'unixepoch') AS day,
  COALESCE(json_extract(data, '$.providerID'), 'unknown') AS modelProviderId,
  COALESCE(json_extract(data, '$.modelID'), 'unknown') AS model,
  ROUND(SUM(COALESCE(json_extract(data, '$.cost'), 0)), 9) AS loggedCostUsd,
  CAST(SUM(COALESCE(json_extract(data, '$.tokens.input'), 0)) AS INTEGER) AS inputTokens,
  CAST(SUM(COALESCE(json_extract(data, '$.tokens.cache.read'), 0)) AS INTEGER) AS cachedInputTokens,
  CAST(SUM(COALESCE(json_extract(data, '$.tokens.cache.write'), 0)) AS INTEGER) AS cacheWriteTokens,
  CAST(SUM(COALESCE(json_extract(data, '$.tokens.output'), 0)) AS INTEGER) AS outputTokens,
  CAST(SUM(COALESCE(json_extract(data, '$.tokens.reasoning'), 0)) AS INTEGER) AS reasoningTokens
FROM message
WHERE json_extract(data, '$.role') = 'assistant'
  AND time_created >= CAST(strftime('%s', 'now', '-365 days') AS INTEGER) * 1000
GROUP BY day, modelProviderId, model
ORDER BY day, modelProviderId, model;`.trim();
  const path = shellQuote(databasePath);
  return [
    `db=${path}`,
    `if [ ! -f "$db" ]; then printf '%s\\n' '__BB_USAGE_NO_DATABASE__'; exit 0; fi`,
    `if ! command -v sqlite3 >/dev/null 2>&1; then printf '%s\\n' '__BB_USAGE_ERROR__:sqlite3 is required to collect OpenCode usage.'; exit 127; fi`,
    `printf '%s\\n' '__BB_USAGE_BEGIN__'`,
    `sqlite3 -readonly -json "$db" ${shellQuote(sql)}`,
    `status=$?`,
    `printf '\\n%s:%s\\n' '__BB_USAGE_END__' "$status"`,
    `exit "$status"`,
  ].join("; ");
}

function extractOpenCodeJson(output: string) {
  if (output.includes("__BB_USAGE_NO_DATABASE__")) return null;
  const start = output.indexOf("__BB_USAGE_BEGIN__");
  const end = output.lastIndexOf("__BB_USAGE_END__:");
  if (start < 0 || end < 0 || end <= start) throw new Error("OpenCode metadata query returned incomplete output.");
  const status = Number(output.slice(end).match(/__BB_USAGE_END__:(\d+)/)?.[1] ?? NaN);
  if (!Number.isFinite(status) || status !== 0) throw new Error(`OpenCode SQLite query failed with code ${Number.isFinite(status) ? status : "unknown"}.`);
  return output.slice(start + "__BB_USAGE_BEGIN__".length, end).trim() || "[]";
}

async function syncOpenCode(
  bb: BbPluginApi,
  db: Database,
  machine: Machine,
  home: string,
  settings: CollectorSettings,
) {
  const agentId: AgentId = "opencode";
  const generation = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const databasePath = expandHome(settings.openCodeDatabasePath, home) || `${home}/.local/share/opencode/opencode.db`;
  const sourceId = opaqueId(machine.id, agentId, databasePath);
  try {
    const output = await runHostCommand(bb, machine, openCodeCommand(databasePath));
    const json = extractOpenCodeJson(output);
    if (json === null) {
      reconcileSources(db, machine.id, agentId, generation);
      upsertState(db, machine.id, agentId, "no-data", 0, null, true);
      bb.log.info(`${machine.name}/opencode: no database found`);
      return;
    }
    const records = parseOpenCode(json, { machineId: machine.id, machineName: machine.name });
    const sha256 = createHash("sha256").update(json).digest("hex");
    upsertSourceEvents(db, {
      id: sourceId,
      rootReference: opaqueId(databasePath),
      sha256,
      generation,
    }, machine, agentId, records);
    reconcileSources(db, machine.id, agentId, generation);
    const recordCount = countForMachine(db, machine.id, agentId);
    upsertState(db, machine.id, agentId, recordCount > 0 ? "ready" : "no-data", recordCount, null, true);
    bb.log.info(`${machine.name}/opencode: ${recordCount} records`);
  } catch (error) {
    const recordCount = countForMachine(db, machine.id, agentId);
    const message = errorMessage(error);
    upsertState(db, machine.id, agentId, "unavailable", recordCount, message, false);
    bb.log.warn(`${machine.name}/opencode: ${message}`);
  }
}

function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    piSessionRoots: {
      type: "string",
      label: "Extra Pi session roots",
      description: "Optional semicolon-separated absolute paths. The default ~/.pi/agent/sessions is always scanned.",
      default: "",
    },
    openCodeDatabasePath: {
      type: "string",
      label: "OpenCode database path",
      description: "Optional override. Defaults to ~/.local/share/opencode/opencode.db.",
      default: "",
    },
  });
  const db = bb.storage.database();
  bb.storage.migrate(db, [migration, pricingMigration, syncMetadataMigration, multiAgentMigration]);
  const syncCoordinator = createSyncCoordinator({
    completedAt: readLastCompletedSyncAt(db),
    persistCompletedAt(completedAt) {
      persistLastCompletedSyncAt(db, completedAt);
    },
  });

  const syncAll = () => {
    const wasRunning = syncCoordinator.snapshot().running;
    const result = syncCoordinator.run(async () => {
      const machines = await bb.sdk.hosts.list();
      reconcileMachines(db, machines.map((machine) => machine.id));
      const collectorSettings = await settings.get();
      for (const machine of machines) {
        if (machine.status !== "connected") {
          for (const agent of AGENTS) upsertState(db, machine.id, agent.id, "offline", countForMachine(db, machine.id, agent.id), null, false);
          continue;
        }
        let home: string;
        try {
          home = (await bb.sdk.hosts.directory({ hostId: machine.id })).directory;
        } catch (error) {
          const message = `Machine home directory could not be resolved: ${errorMessage(error)}`;
          for (const agent of AGENTS) upsertState(db, machine.id, agent.id, "unavailable", countForMachine(db, machine.id, agent.id), message, false);
          continue;
        }
        await Promise.all([
          syncJsonAgent(bb, db, machine, home, "codex", collectorSettings),
          syncJsonAgent(bb, db, machine, home, "claude", collectorSettings),
          syncJsonAgent(bb, db, machine, home, "grok", collectorSettings),
          syncJsonAgent(bb, db, machine, home, "pi", collectorSettings),
          syncOpenCode(bb, db, machine, home, collectorSettings),
        ]);
      }
      return new Date().toISOString();
    });

    if (!wasRunning) {
      bb.realtime.publish("usage-updated", { stage: "started" });
      void result.then(
        (completedAt) => bb.realtime.publish("usage-updated", { stage: "completed", completedAt }),
        () => bb.realtime.publish("usage-updated", { stage: "failed" }),
      );
    }

    return result;
  };

  bb.rpc.register(rpcContract, {
    async dashboard() {
      const machines = (await bb.sdk.hosts.list()).map((host) => ({ id: host.id, name: host.name, status: host.status }));
      const machineNames = new Map(machines.map((machine) => [machine.id, machine.name]));
      const providerLimits = (await Promise.all(machines
        .filter((machine) => machine.status === "connected")
        .map(async (machine) => {
          try {
            const usage = await bb.sdk.system.usageLimits({ hostId: machine.id });
            return LIMIT_PROVIDERS.flatMap((provider) => {
              const limit = usage[provider.key];
              if (limit.status !== "ok" || limit.windows.length === 0) return [];
              return [{
                machineId: machine.id,
                machineName: machine.name,
                providerId: provider.id,
                providerName: provider.name,
                planLabel: limit.planLabel,
                windows: limit.windows,
              }];
            });
          } catch (error) {
            bb.log.debug(`Provider limits unavailable for ${machine.name}: ${errorMessage(error)}`);
            return [];
          }
        }))).flat();
      const rows = db.prepare(`WITH canonical AS (
          SELECT e.*, MIN(s.machine_id) machine_id FROM usage_events e
          JOIN usage_event_sources es ON es.event_key=e.event_key JOIN usage_sources s ON s.source_id=es.source_id
          GROUP BY e.event_key
        ) SELECT day, provider_id agentId, provider_name agentName,
        model_provider_id modelProviderId, model_provider_name modelProviderName, machine_id machineId, model,
        SUM(cost_usd) costUsd,
        CASE WHEN COUNT(logged_cost_usd)=0 THEN NULL ELSE SUM(logged_cost_usd) END loggedCostUsd,
        CASE
          WHEN SUM(CASE WHEN pricing_status='unknown' THEN 1 ELSE 0 END)>0 THEN 'unknown'
          WHEN SUM(CASE WHEN pricing_status='logged' THEN 1 ELSE 0 END)>0 THEN 'logged'
          WHEN SUM(CASE WHEN pricing_status='models-dev-alias' THEN 1 ELSE 0 END)>0 THEN 'models-dev-alias'
          ELSE 'models-dev-exact'
        END pricingStatus,
        SUM(cache_savings_usd) cacheSavingsUsd, SUM(processed_tokens) processedTokens,
        SUM(cached_input_tokens) cachedInputTokens, SUM(cache_write_tokens) cacheWriteTokens,
        SUM(uncached_input_tokens) uncachedInputTokens, SUM(output_tokens) outputTokens
        FROM canonical WHERE day >= date('now', '-365 days')
        AND NOT (provider_id='claude' AND model='<synthetic>' AND processed_tokens=0)
        GROUP BY day, provider_id, model_provider_id, machine_id, model ORDER BY day`).all() as Array<Omit<DashboardRecord, "machineName">>;
      const records = rows.map((row) => ({ ...row, machineName: machineNames.get(row.machineId) ?? "Unknown machine" }));
      const sources = db.prepare(`SELECT machine_id machineId, provider_id agentId, status, last_attempt_at lastAttemptAt,
        last_success_at lastSuccessAt, record_count recordCount, error FROM usage_sync_state ORDER BY machine_id, provider_id`).all() as SourceState[];
      const sync = syncCoordinator.snapshot();
      const modelProviders = db.prepare(`SELECT model_provider_id id, MAX(model_provider_name) name
        FROM usage_events GROUP BY model_provider_id ORDER BY name`).all() as Array<{ id: string; name: string }>;
      return {
        mode: "live" as const,
        generatedAt: new Date().toISOString(),
        lastSyncedAt: sync.completedAt,
        pricingVersion: PRICING_VERSION,
        machines,
        agents: [...AGENTS],
        modelProviders,
        records,
        sources,
        providerLimits,
        sync,
        notice: "Prompts and message content are never stored. Costs use models.dev estimates when available, then agent-reported cost; subscription charges may differ.",
      };
    },
    sync() {
      void syncAll().catch((error) => bb.log.error(`Usage sync failed: ${errorMessage(error)}`));
      return { ok: true as const };
    },
  });

  bb.background.service("usage-collector", {
    async start(signal) {
      while (!signal.aborted) {
        try { await syncAll(); } catch (error) { bb.log.error(`Usage sync failed: ${errorMessage(error)}`); }
        await abortableDelay(15 * 60_000, signal);
      }
    },
  });
}
