import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import {
  parseHostUsageAggregates, parseOpenCode,
  type AgentId, type UsageRecord,
} from "./collectors";
import { activateCachedCatalog, refreshCatalog } from "./lib/catalog";
import { openCodeGoUsageCommand, parseOpenCodeGoUsage } from "./lib/opencode-go";
import {
  compressedHostJsonCollectorScript,
  extractHostJsonScan,
  type HostJsonAgentId,
} from "./lib/host-json-collector";
import { pricingRevision, pricingVersion } from "./lib/pricing";
import { createSyncCoordinator } from "./lib/sync-coordinator";
import { persistLastCompletedSyncAt, readLastCompletedSyncAt, syncMetadataMigration } from "./lib/sync-metadata";

const usageRecordSchema = z.object({
  day: z.string(), agentId: z.string(), agentName: z.string(),
  modelProviderId: z.string(), modelProviderName: z.string(),
  machineId: z.string(), machineName: z.string(), model: z.string(), project: z.string(),
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
  status: z.enum(["ok", "error"]), error: z.string().nullable(), lastUpdatedAt: z.string().nullable(),
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
type CollectorSettings = { piSessionRoots: string; primeSessionRoots: string };

const AGENTS = [
  { id: "codex", name: "Codex" },
  { id: "claude", name: "Claude Code" },
  { id: "fx", name: "FX" },
  { id: "grok", name: "Grok Agent" },
  { id: "opencode", name: "OpenCode" },
  { id: "pi", name: "Pi" },
  { id: "prime", name: "Prime Agent" },
  { id: "antigravity", name: "Antigravity" },
] as const satisfies ReadonlyArray<{ id: AgentId; name: string }>;

const LIMIT_PROVIDERS = [
  { key: "codex", id: "codex", name: "Codex" },
  { key: "claudeCode", id: "claude", name: "Claude Code" },
  { key: "cursor", id: "cursor", name: "Cursor" },
] as const;
const PROVIDER_LIMITS_TIMEOUT_MS = 3_000;
const DASHBOARD_HOSTS_TIMEOUT_MS = 5_000;
const SYNC_HOSTS_TIMEOUT_MS = 10_000;
const HOST_DIRECTORY_TIMEOUT_MS = 10_000;
const JSON_AGENT_SYNC_TIMEOUT_MS = 10 * 60_000;
const OPENCODE_SYNC_TIMEOUT_MS = 60_000;
const OPENCODE_GO_SYNC_TIMEOUT_MS = 60_000;
const OPENCODE_GO_ABSENCE_ERRORS = new Set(["no-opencode-go-credential", "no-opencode-go-plan"]);
const DASHBOARD_HISTORY_DAYS = 90;
const OPENCODE_HISTORY_DAYS = DASHBOARD_HISTORY_DAYS;
const HISTORY_DAYS = 365;

function timeoutSignal(timeoutMs: number, parent?: AbortSignal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

export async function loadProviderLimits(
  bb: BbPluginApi,
  machines: Array<Machine & { status: string }>,
  db: Database,
  timeoutMs = PROVIDER_LIMITS_TIMEOUT_MS,
): Promise<Array<z.infer<typeof providerLimitSchema>>> {
  return (await Promise.all(machines
    .filter((machine) => machine.status === "connected")
    .map(async (machine) => {
      const presentRows = db.prepare(`SELECT DISTINCT s.provider_id agentId FROM usage_sources s
        JOIN usage_event_sources es ON es.source_id = s.source_id
        WHERE s.machine_id = ? AND s.provider_id IN (?, ?, ?)`)
        .all(machine.id, "codex", "claude", "cursor") as Array<{ agentId: string }>;
      const present = new Set(presentRows.map((row) => row.agentId));
      try {
        const usage = await bb.sdk.system.usageLimits({ hostId: machine.id, signal: AbortSignal.timeout(timeoutMs) });
        return LIMIT_PROVIDERS.flatMap((provider): Array<z.infer<typeof providerLimitSchema>> => {
          const limit = usage[provider.key];
          if (limit.status === "ok") {
            if (limit.windows.length === 0) return [];
            return [{
              machineId: machine.id,
              machineName: machine.name,
              providerId: provider.id,
              providerName: provider.name,
              planLabel: limit.planLabel,
              windows: limit.windows,
              status: "ok",
              error: null,
              lastUpdatedAt: null,
            }];
          }
          if (limit.status === "error") {
            bb.log.debug(`Provider limits unavailable for ${provider.name} on ${machine.name}: ${limit.message}`);
            return [{
              machineId: machine.id,
              machineName: machine.name,
              providerId: provider.id,
              providerName: provider.name,
              planLabel: limit.planLabel,
              windows: [],
              status: "error",
              error: limit.message,
              lastUpdatedAt: null,
            }];
          }
          return [];
        });
      } catch (error) {
        const message = `Provider limits unavailable: ${errorMessage(error)}`;
        bb.log.debug(`Provider limits unavailable for ${machine.name}: ${errorMessage(error)}`);
        return LIMIT_PROVIDERS
          .filter((provider) => present.has(provider.id))
          .map((provider): z.infer<typeof providerLimitSchema> => ({
            machineId: machine.id,
            machineName: machine.name,
            providerId: provider.id,
            providerName: provider.name,
            planLabel: null,
            windows: [],
            status: "error",
            error: message,
            lastUpdatedAt: null,
          }));
      }
    }))).flat();
}

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
const projectMigration = `
ALTER TABLE usage_events ADD COLUMN project TEXT NOT NULL DEFAULT 'Unknown';
CREATE INDEX IF NOT EXISTS usage_events_project_idx ON usage_events(project, day);
`;
const pricingCatalogMigration = `CREATE TABLE IF NOT EXISTS pricing_catalog (
  id INTEGER PRIMARY KEY CHECK (id = 1), revision TEXT NOT NULL, fetched_at TEXT NOT NULL, data TEXT NOT NULL
);`;
const openCodeGoLimitsMigration = `
CREATE TABLE IF NOT EXISTS opencode_go_limits (
  machine_id TEXT PRIMARY KEY, machine_name TEXT NOT NULL, plan_label TEXT NOT NULL DEFAULT 'Go',
  windows_json TEXT NOT NULL, fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS opencode_go_limit_state (
  machine_id TEXT PRIMARY KEY, machine_name TEXT NOT NULL, status TEXT NOT NULL,
  error TEXT, last_attempt_at TEXT NOT NULL, last_success_at TEXT
);`;

function opaqueId(...parts: string[]) {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 300) || "Unknown error.";
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function expandHome(path: string, home: string) {
  const trimmed = path.trim();
  if (!trimmed) return "";
  return trimmed === "~" ? home : trimmed.startsWith("~/") ? `${home}/${trimmed.slice(2)}` : trimmed;
}

function normalizeRoot(path: string) {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function configuredRoots(value: string, home: string) {
  return [...new Set(value.split(/[;\n]/).map((part) => normalizeRoot(expandHome(part, home))).filter(Boolean))];
}

function parentDirectory(path: string) {
  const normalized = normalizeRoot(path);
  const separator = normalized.lastIndexOf("/");
  return separator > 0 ? normalized.slice(0, separator) : separator === 0 ? "/" : ".";
}

function primeRoots(home: string, configured: string) {
  const sessionRoots = [`${home}/.prime/agent/sessions`, ...configuredRoots(configured, home)];
  return [...new Set(sessionRoots.flatMap((root) => {
    const parent = parentDirectory(root);
    return [root, parent === "/" ? "/session-artifacts" : `${parent}/session-artifacts`];
  }))];
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
      model_provider_id, model_provider_name, logged_cost_usd, pricing_status, project
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_key) DO UPDATE SET timestamp=excluded.timestamp, day=excluded.day, provider_id=excluded.provider_id,
    provider_name=excluded.provider_name, model=excluded.model, cost_usd=excluded.cost_usd, project=excluded.project,
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
      .run(source.id, machine.id, machine.name, agentId, source.rootReference, source.sha256, source.generation, new Date().toISOString(), pricingRevision());
    db.prepare("DELETE FROM usage_event_sources WHERE source_id=?").run(source.id);
    for (const row of records) {
      insertEvent.run(
        row.eventKey, row.timestamp, row.day, row.agentId, row.agentName, row.model, row.costUsd, row.cacheSavingsUsd,
        row.processedTokens, row.cachedInputTokens, row.cacheWriteTokens, row.uncachedInputTokens, row.outputTokens,
        row.modelProviderId, row.modelProviderName, row.loggedCostUsd, row.pricingStatus, row.project,
      );
      insertMapping.run(row.eventKey, source.id);
    }
    db.prepare("DELETE FROM usage_events WHERE event_key NOT IN (SELECT event_key FROM usage_event_sources)").run();
  })();
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
    db.prepare(`DELETE FROM opencode_go_limits WHERE machine_id NOT IN (${placeholders})`).run(...machineIds);
    db.prepare(`DELETE FROM opencode_go_limit_state WHERE machine_id NOT IN (${placeholders})`).run(...machineIds);
    db.prepare("DELETE FROM usage_events WHERE event_key NOT IN (SELECT event_key FROM usage_event_sources)").run();
  })();
}

export function jsonAgentRoots(home: string, agentId: HostJsonAgentId, settings: CollectorSettings) {
  const resolvedPrimeRoots = primeRoots(home, settings.primeSessionRoots);
  return agentId === "codex" ? [`${home}/.codex/sessions`]
    : agentId === "claude" ? [`${home}/.claude/projects`]
    : agentId === "fx" ? [`${home}/.fx/usage.jsonl`]
    : agentId === "grok" ? [`${home}/.grok/logs`]
    : agentId === "antigravity" ? [`${home}/.antigravity-acp/usage.jsonl`]
    : agentId === "prime" ? resolvedPrimeRoots
    : [`${home}/.pi/agent/sessions`, ...configuredRoots(settings.piSessionRoots, home).filter((root) => {
      const defaultPrimeAgentRoot = `${home}/.prime/agent`;
      return root !== defaultPrimeAgentRoot && !resolvedPrimeRoots.includes(root);
    })];
}

function historyStartDay() {
  const start = new Date();
  start.setDate(start.getDate() - HISTORY_DAYS);
  return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
}

function jsonAgentCommand(input: Parameters<typeof compressedHostJsonCollectorScript>[0]) {
  const script = compressedHostJsonCollectorScript(input);
  return [
    "if ! command -v node >/dev/null 2>&1",
    "then printf '%s\\n' '__BB_USAGE_ERROR__:Node.js is required to scan agent usage logs.'; exit 127",
    "fi",
    `node -e ${shellQuote(script)}`,
  ].join("; ");
}

async function syncJsonAgent(
  bb: BbPluginApi,
  db: Database,
  machine: Machine,
  home: string,
  agentId: HostJsonAgentId,
  settings: CollectorSettings,
  signal: AbortSignal,
) {
  const generation = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const roots = [...new Set(jsonAgentRoots(home, agentId, settings))];
    const cachePath = `${home}/.cache/bb-plugin-usage/json-log-scan-v1/${agentId}.json`;
    const output = await runHostCommand(bb, machine, jsonAgentCommand({
      agentId,
      roots,
      cachePath,
      sinceDay: historyStartDay(),
    }), signal, {
      title: `Usage: ${agentId} scan`,
      timeoutMs: JSON_AGENT_SYNC_TIMEOUT_MS,
    });
    const scan = extractHostJsonScan(output);
    if (scan.agentId !== agentId) throw new Error(`Host usage scan returned ${scan.agentId} data for ${agentId}.`);
    const aggregateJson = JSON.stringify(scan.rows);
    const records = parseHostUsageAggregates(aggregateJson, agentId, {
      machineId: machine.id,
      machineName: machine.name,
    });
    const sourceId = opaqueId(machine.id, agentId, "host-json-scan-v1", ...roots);
    upsertSourceEvents(db, {
      id: sourceId,
      rootReference: opaqueId(...roots),
      sha256: createHash("sha256").update(aggregateJson).digest("hex"),
      generation,
    }, machine, agentId, records);
    reconcileSources(db, machine.id, agentId, generation);

    const complete = scan.failureCount === 0;
    const recordCount = countForMachine(db, machine.id, agentId);
    const status = !complete ? "partial" : recordCount > 0 ? "ready" : "no-data";
    const error = scan.failureCount > 0
      ? `${scan.failureCount} source problem${scan.failureCount === 1 ? "" : "s"} prevented a complete scan${scan.error ? `: ${scan.error}` : "."}`
      : null;
    upsertState(db, machine.id, agentId, status, recordCount, error, complete);
    bb.log.info(`${machine.name}/${agentId}: ${recordCount} records from ${scan.fileCount} files (${scan.changedFileCount} changed, ${scan.reusedFileCount} cached, ${status})`);
  } catch (error) {
    const recordCount = countForMachine(db, machine.id, agentId);
    const message = `Usage scan failed: ${errorMessage(error)}`;
    upsertState(db, machine.id, agentId, "unavailable", recordCount, message, false);
    bb.log.warn(`${machine.name}/${agentId}: ${message}`);
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

type HostCommandOptions = { title: string; timeoutMs: number; pollMs?: number };

function heldHostCommand(command: string) {
  return `( ${command} ); bb_usage_status=$?; printf '\\n%s:%s\\n' '__BB_HOST_COMMAND_DONE__' "$bb_usage_status"; while :; do sleep 3600; done`;
}

function terminalOutputText(output: Awaited<ReturnType<BbPluginApi["sdk"]["terminals"]["output"]>>) {
  return output.chunks.sort((a, b) => a.seq - b.seq)
    .map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString("utf8")).join("");
}

export async function runHostCommand(
  bb: BbPluginApi,
  machine: Machine,
  command: string,
  signal: AbortSignal,
  options: HostCommandOptions,
) {
  const terminal = await bb.sdk.terminals.create({
    scope: { kind: "host_path", hostId: machine.id, cwd: null },
    cols: 120,
    rows: 24,
    title: options.title,
    start: { mode: "command", command: heldHostCommand(command) },
  });
  try {
    const deadline = Date.now() + options.timeoutMs;
    while (Date.now() < deadline) {
      const state = await bb.sdk.terminals.get({ terminalId: terminal.id, signal });
      if (state.status === "running") {
        const output = await bb.sdk.terminals.output({
          terminalId: terminal.id,
          tailBytes: 900_000,
          limitChunks: 4000,
          signal,
        });
        if (output.truncated) throw new Error(`${options.title} exceeded the 900 KB output limit.`);
        const text = terminalOutputText(output);
        const completion = text.match(/__BB_HOST_COMMAND_DONE__:(\d+)/);
        if (completion) {
          const exitCode = Number(completion[1]);
          if (exitCode !== 0) {
            const diagnostic = text.match(/__BB_USAGE_ERROR__:(.+)/)?.[1]?.trim()
              ?? text.replace(/__BB_HOST_COMMAND_DONE__:\d+/g, "").trim().slice(-300);
            throw new Error(diagnostic || `${options.title} exited with code ${exitCode}.`);
          }
          return text;
        }
      } else if (state.status !== "starting" && state.status !== "disconnected") {
        throw new Error(`${options.title} stopped before its output could be collected.`);
      }
      await delay(options.pollMs ?? 200);
    }
    throw new Error(`${options.title} timed out after ${Math.ceil(options.timeoutMs / 1000)} seconds.`);
  } finally {
    await bb.sdk.terminals.close({ terminalId: terminal.id, mode: "force" }).catch(() => { /* already closed by the host */ });
  }
}

// OpenCode usage is collected on the enrolled HOST (via `opencode db`), so the
// day bucket and the 90-day cutoff MUST use the host's local timezone, not
// UTC. Otherwise machines in a positive/negative offset see "today"'s usage
// land in the previous/next UTC day.
//
// The trailing 'utc' modifier is required: 'localtime' shifts the stored value
// into local time, but '%s' formats it as if it were still UTC, so without the
// conversion back the cutoff is wrong by the host's offset.
export function openCodeSql(): string {
  const oldestDayOffset = OPENCODE_HISTORY_DAYS - 1;
  return `
WITH recent_sessions AS MATERIALIZED (
  SELECT id
  FROM session
  WHERE time_updated >= CAST(strftime('%s', 'now', 'localtime', 'start of day', '-${oldestDayOffset} days', 'utc') AS INTEGER) * 1000
)
SELECT
  date(m.time_created / 1000, 'unixepoch', 'localtime') AS day,
  COALESCE(json_extract(m.data, '$.providerID'), 'unknown') AS modelProviderId,
  COALESCE(json_extract(m.data, '$.modelID'), 'unknown') AS model,
  ROUND(SUM(COALESCE(json_extract(m.data, '$.cost'), 0)), 9) AS loggedCostUsd,
  CAST(SUM(COALESCE(json_extract(m.data, '$.tokens.input'), 0)) AS INTEGER) AS inputTokens,
  CAST(SUM(COALESCE(json_extract(m.data, '$.tokens.cache.read'), 0)) AS INTEGER) AS cachedInputTokens,
  CAST(SUM(COALESCE(json_extract(m.data, '$.tokens.cache.write'), 0)) AS INTEGER) AS cacheWriteTokens,
  CAST(SUM(COALESCE(json_extract(m.data, '$.tokens.output'), 0)) AS INTEGER) AS outputTokens,
  CAST(SUM(COALESCE(json_extract(m.data, '$.tokens.reasoning'), 0)) AS INTEGER) AS reasoningTokens
FROM recent_sessions rs
JOIN message m ON m.session_id = rs.id
WHERE json_extract(m.data, '$.role') = 'assistant'
  AND m.time_created >= CAST(strftime('%s', 'now', 'localtime', 'start of day', '-${oldestDayOffset} days', 'utc') AS INTEGER) * 1000
GROUP BY day, modelProviderId, model
ORDER BY day, modelProviderId, model;`.trim();
}

export function openCodeCommand() {
  const sql = openCodeSql();
  return [
    `if ! command -v opencode >/dev/null 2>&1; then printf '%s\\n' '__BB_USAGE_ERROR__:OpenCode CLI is required to collect OpenCode usage.'; exit 127; fi`,
    `result=$(opencode db ${shellQuote(sql)} --format json 2>&1)`,
    `bb_usage_query_status=$?`,
    `if [ "$bb_usage_query_status" -ne 0 ]; then diagnostic=$(printf '%s' "$result" | tr '\\r\\n' ' ' | cut -c1-240); printf '%s%s\\n' '__BB_USAGE_ERROR__:OpenCode usage query failed' "\${diagnostic:+: $diagnostic}"; exit "$bb_usage_query_status"; fi`,
    `printf '%s\\n' '__BB_USAGE_BEGIN__'`,
    `printf '%s\\n' "$result"`,
    `printf '%s\\n' '__BB_USAGE_END__:0'`,
  ].join("; ");
}

export function extractOpenCodeJson(output: string) {
  const start = output.indexOf("__BB_USAGE_BEGIN__");
  const end = output.lastIndexOf("__BB_USAGE_END__:");
  if (start < 0 || end < 0 || end <= start) throw new Error("OpenCode metadata query returned incomplete output.");
  const status = Number(output.slice(end).match(/__BB_USAGE_END__:(\d+)/)?.[1] ?? NaN);
  if (!Number.isFinite(status) || status !== 0) throw new Error(`OpenCode usage query failed with code ${Number.isFinite(status) ? status : "unknown"}.`);
  return output.slice(start + "__BB_USAGE_BEGIN__".length, end).trim() || "[]";
}

export async function syncOpenCode(
  bb: BbPluginApi,
  db: Database,
  machine: Machine,
  signal: AbortSignal,
  executeHostCommand = runHostCommand,
) {
  const agentId: AgentId = "opencode";
  const generation = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const sourceId = opaqueId(machine.id, agentId, "opencode-cli-db-v1");
  try {
    const output = await executeHostCommand(bb, machine, openCodeCommand(), signal, {
      title: "Usage: OpenCode scan",
      timeoutMs: OPENCODE_SYNC_TIMEOUT_MS,
    });
    const json = extractOpenCodeJson(output);
    const records = parseOpenCode(json, { machineId: machine.id, machineName: machine.name });
    const sha256 = createHash("sha256").update(json).digest("hex");
    upsertSourceEvents(db, {
      id: sourceId,
      rootReference: opaqueId("opencode-cli-db-v1"),
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
    if (message.includes("OpenCode CLI is required")) {
      upsertState(db, machine.id, agentId, "skipped", recordCount,
        "OpenCode CLI is not installed; hosted OpenCode Go usage is already collected via Prime Agent sessions.", false);
      bb.log.info(`${machine.name}/opencode: skipped (no local OpenCode CLI)`);
    } else {
      upsertState(db, machine.id, agentId, "unavailable", recordCount, message, false);
      bb.log.warn(`${machine.name}/opencode: ${message}`);
    }
  }
}
export async function syncOpenCodeGo(
  bb: BbPluginApi,
  db: Database,
  machine: Machine,
  signal: AbortSignal,
  executeHostCommand = runHostCommand,
) {
  const attemptedAt = new Date().toISOString();
  try {
    const output = await executeHostCommand(bb, machine, openCodeGoUsageCommand(), signal, {
      title: "Usage: OpenCode Go limits",
      timeoutMs: OPENCODE_GO_SYNC_TIMEOUT_MS,
    });
    const windows = parseOpenCodeGoUsage(extractOpenCodeJson(output));
    if (windows.length === 0) throw new Error("OpenCode Go usage response contained no limit windows.");

    db.transaction(() => {
      db.prepare(`INSERT INTO opencode_go_limits (machine_id, machine_name, plan_label, windows_json, fetched_at)
        VALUES (?, ?, 'Go', ?, ?) ON CONFLICT(machine_id) DO UPDATE SET
        machine_name=excluded.machine_name, windows_json=excluded.windows_json, fetched_at=excluded.fetched_at`)
        .run(machine.id, machine.name, JSON.stringify(windows), attemptedAt);
      db.prepare(`INSERT INTO opencode_go_limit_state (
          machine_id, machine_name, status, error, last_attempt_at, last_success_at
        ) VALUES (?, ?, 'ok', NULL, ?, ?) ON CONFLICT(machine_id) DO UPDATE SET
        machine_name=excluded.machine_name, status='ok', error=NULL,
        last_attempt_at=excluded.last_attempt_at, last_success_at=excluded.last_success_at`)
        .run(machine.id, machine.name, attemptedAt, attemptedAt);
    })();
    bb.log.info(`${machine.name}/opencode-go: ${windows.length} limit windows`);
  } catch (error) {
    const message = errorMessage(error);
    if (OPENCODE_GO_ABSENCE_ERRORS.has(message)) {
      db.transaction(() => {
        db.prepare("DELETE FROM opencode_go_limits WHERE machine_id=?").run(machine.id);
        db.prepare("DELETE FROM opencode_go_limit_state WHERE machine_id=?").run(machine.id);
      })();
      bb.log.debug(`${machine.name}/opencode-go: not configured (${message})`);
      return;
    }

    const hasSnapshot = Boolean(db.prepare("SELECT 1 FROM opencode_go_limits WHERE machine_id=?").get(machine.id));
    db.prepare(`INSERT INTO opencode_go_limit_state (
        machine_id, machine_name, status, error, last_attempt_at, last_success_at
      ) VALUES (?, ?, 'error', ?, ?, NULL) ON CONFLICT(machine_id) DO UPDATE SET
      machine_name=excluded.machine_name, status='error', error=excluded.error,
      last_attempt_at=excluded.last_attempt_at`)
      .run(machine.id, machine.name, message, attemptedAt);
    bb.log.warn(`${machine.name}/opencode-go: ${hasSnapshot ? "retaining previous snapshot; " : ""}${message}`);
  }
}

export function loadStoredOpenCodeGoLimits(
  db: Database,
  connectedMachineIds: Set<string>,
): Array<z.infer<typeof providerLimitSchema>> {
  const rows = db.prepare(`SELECT
      state.machine_id machineId, state.machine_name machineName, state.status, state.error,
      limits.plan_label planLabel, limits.windows_json windowsJson, limits.fetched_at fetchedAt
    FROM opencode_go_limit_state state
    LEFT JOIN opencode_go_limits limits ON limits.machine_id=state.machine_id
    ORDER BY state.machine_name`).all() as Array<{
    machineId: string; machineName: string; status: "ok" | "error"; error: string | null;
    planLabel: string | null; windowsJson: string | null; fetchedAt: string | null;
  }>;

  return rows.flatMap((row): Array<z.infer<typeof providerLimitSchema>> => {
    if (!connectedMachineIds.has(row.machineId)) return [];
    try {
      const windows = row.windowsJson
        ? providerLimitWindowSchema.array().parse(JSON.parse(row.windowsJson))
        : [];
      if (row.status === "ok" && windows.length === 0) {
        throw new Error("OpenCode Go has no stored limit windows.");
      }
      return [{
        machineId: row.machineId,
        machineName: row.machineName,
        providerId: "opencode-go",
        providerName: "OpenCode Go",
        planLabel: row.planLabel ?? "Go",
        windows,
        status: row.status,
        error: row.error,
        lastUpdatedAt: row.fetchedAt,
      }];
    } catch {
      return [{
        machineId: row.machineId,
        machineName: row.machineName,
        providerId: "opencode-go",
        providerName: "OpenCode Go",
        planLabel: row.planLabel ?? "Go",
        windows: [],
        status: "error",
        error: "Stored OpenCode Go limits could not be read.",
        lastUpdatedAt: row.fetchedAt,
      }];
    }
  });
}

// Rows are bucketed by each host's local day, so the plugin server's timezone
// cannot decide the exact visible window without clipping a host that is ahead
// of it. This query only bounds retention -- it fetches one extra day of slack
// and the dashboard applies the exact range in the viewer's timezone.
export function dashboardRecordsSql() {
  return `WITH canonical AS (
      SELECT e.*, MIN(s.machine_id) machine_id FROM usage_events e
      JOIN usage_event_sources es ON es.event_key=e.event_key JOIN usage_sources s ON s.source_id=es.source_id
      GROUP BY e.event_key
    ) SELECT day, provider_id agentId, provider_name agentName,
    model_provider_id modelProviderId, model_provider_name modelProviderName, machine_id machineId, model, project,
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
    FROM canonical WHERE day >= date('now', 'localtime', '-${DASHBOARD_HISTORY_DAYS} days')
    AND NOT (provider_id='claude' AND model='<synthetic>' AND processed_tokens=0)
    GROUP BY day, provider_id, model_provider_id, machine_id, model, project ORDER BY day`;
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
    primeSessionRoots: {
      type: "string",
      label: "Extra Prime Agent session roots",
      description: "Optional semicolon-separated absolute session directories. The default ~/.prime/agent/sessions and its recursive-agent artifacts are always scanned.",
      default: "",
    },
  });
  const db = bb.storage.database();
  bb.storage.migrate(db, [migration, pricingMigration, syncMetadataMigration, multiAgentMigration, pricingCatalogMigration, projectMigration, openCodeGoLimitsMigration]);
  activateCachedCatalog(db);
  const syncCoordinator = createSyncCoordinator({
    completedAt: readLastCompletedSyncAt(db),
    persistCompletedAt(completedAt) {
      persistLastCompletedSyncAt(db, completedAt);
    },
  });

  const syncAll = (serviceSignal?: AbortSignal) => {
    const wasRunning = syncCoordinator.snapshot().running;
    const result = syncCoordinator.run(async () => {
      activateCachedCatalog(db);
      const machines = await bb.sdk.hosts.list({ signal: timeoutSignal(SYNC_HOSTS_TIMEOUT_MS, serviceSignal) });
      reconcileMachines(db, machines.map((machine) => machine.id));
      const collectorSettings = await settings.get();
      for (const machine of machines) {
        if (serviceSignal?.aborted) throw serviceSignal.reason;
        if (machine.status !== "connected") {
          for (const agent of AGENTS) upsertState(db, machine.id, agent.id, "offline", countForMachine(db, machine.id, agent.id), null, false);
          continue;
        }
        let home: string;
        try {
          home = (await bb.sdk.hosts.directory({
            hostId: machine.id,
            signal: timeoutSignal(HOST_DIRECTORY_TIMEOUT_MS, serviceSignal),
          })).directory;
        } catch (error) {
          const message = `Machine home directory could not be resolved: ${errorMessage(error)}`;
          for (const agent of AGENTS) upsertState(db, machine.id, agent.id, "unavailable", countForMachine(db, machine.id, agent.id), message, false);
          continue;
        }
        await Promise.all([
          syncJsonAgent(bb, db, machine, home, "codex", collectorSettings, timeoutSignal(JSON_AGENT_SYNC_TIMEOUT_MS, serviceSignal)),
          syncJsonAgent(bb, db, machine, home, "claude", collectorSettings, timeoutSignal(JSON_AGENT_SYNC_TIMEOUT_MS, serviceSignal)),
          syncJsonAgent(bb, db, machine, home, "fx", collectorSettings, timeoutSignal(JSON_AGENT_SYNC_TIMEOUT_MS, serviceSignal)),
          syncJsonAgent(bb, db, machine, home, "grok", collectorSettings, timeoutSignal(JSON_AGENT_SYNC_TIMEOUT_MS, serviceSignal)),
          syncJsonAgent(bb, db, machine, home, "pi", collectorSettings, timeoutSignal(JSON_AGENT_SYNC_TIMEOUT_MS, serviceSignal)),
          syncJsonAgent(bb, db, machine, home, "prime", collectorSettings, timeoutSignal(JSON_AGENT_SYNC_TIMEOUT_MS, serviceSignal)),
          syncJsonAgent(bb, db, machine, home, "antigravity", collectorSettings, timeoutSignal(JSON_AGENT_SYNC_TIMEOUT_MS, serviceSignal)),
          syncOpenCode(bb, db, machine, timeoutSignal(OPENCODE_SYNC_TIMEOUT_MS, serviceSignal)),
          syncOpenCodeGo(bb, db, machine, timeoutSignal(OPENCODE_GO_SYNC_TIMEOUT_MS, serviceSignal)),
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
      let machines: Array<Machine & { status: string }>;
      try {
        machines = (await bb.sdk.hosts.list({ signal: AbortSignal.timeout(DASHBOARD_HOSTS_TIMEOUT_MS) }))
          .map((host) => ({ id: host.id, name: host.name, status: host.status }));
      } catch (error) {
        bb.log.warn(`Machine list unavailable: ${errorMessage(error)}`);
        machines = db.prepare(`SELECT machine_id id, MAX(machine_name) name, 'unavailable' status
          FROM usage_sources GROUP BY machine_id ORDER BY name`).all() as typeof machines;
      }
      const machineNames = new Map(machines.map((machine) => [machine.id, machine.name]));
      const connectedMachineIds = new Set(machines.filter((machine) => machine.status === "connected").map((machine) => machine.id));
      const providerLimits = [
        ...await loadProviderLimits(bb, machines, db),
        ...loadStoredOpenCodeGoLimits(db, connectedMachineIds),
      ];
      const rows = db.prepare(dashboardRecordsSql()).all() as Array<Omit<DashboardRecord, "machineName">>;
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
        pricingVersion: pricingVersion(),
        machines,
        agents: [...AGENTS],
        modelProviders,
        records,
        sources,
        providerLimits,
        sync,
        notice: "Prompts and message content are never stored.",
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
        try { await syncAll(signal); } catch (error) {
          if (!signal.aborted) bb.log.error(`Usage sync failed: ${errorMessage(error)}`);
        }
        if (signal.aborted) break;
        try { await refreshCatalog(db); } catch (error) {
          bb.log.warn(`models.dev catalog refresh failed: ${errorMessage(error)}`);
        }
        await abortableDelay(15 * 60_000, signal);
      }
    },
  });
}
