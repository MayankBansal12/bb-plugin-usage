import { grokLimitsCommand, grokLimitSnapshotSchema } from "./lib/grok-limits";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import {
  codexHomeTag, parseAmpUsageAggregates, parseHostUsageAggregates, parseOpenCode, repriceUsageRecord,
  type AgentId, type UsageRecord,
} from "./collectors";
import { compressedAmpUsageCollectorScript, extractAmpUsageScan } from "./lib/amp-usage-collector";
import { activateCachedCatalog, refreshCatalog } from "./lib/catalog";
import { openCodeGoUsageCommand, extractOpenCodeGoFingerprint, parseOpenCodeGoUsage } from "./lib/opencode-go";
import {
  compressedHostJsonCollectorScript,
  extractHostJsonScan,
  type HostJsonAgentId,
} from "./lib/host-json-collector";
import { compressedDevinCollectorScript } from "./lib/devin-sqlite-collector";
import { compressedKilocodeCollectorScript } from "./lib/kilocode-sqlite-collector";
import { pricingRevision, pricingVersion } from "./lib/pricing";
import { createSyncCoordinator } from "./lib/sync-coordinator";
import { persistLastCompletedSyncAt, readLastCompletedSyncAt, syncMetadataMigration } from "./lib/sync-metadata";
import { groupProviderLimits, type ProviderLimitSource } from "./lib/provider-limits";
import { createAccountPoolLimitsLoader, mergeAccountPoolLimits } from "./lib/account-pool-limits";

const usageRecordSchema = z.object({
  day: z.string(), agentId: z.string(), agentName: z.string(),
  modelProviderId: z.string(), modelProviderName: z.string(),
  machineId: z.string(), machineName: z.string(), model: z.string(), project: z.string(),
  unknownPricedTokens: z.number(), costUsd: z.number(), loggedCostUsd: z.number().nullable(), pricingStatus: z.string(),
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
  poolAccount: z.object({ id: z.string(), label: z.string(), status: z.string(), emptyMessage: z.string() }).optional(),
  id: z.string(),
  providerId: z.string(), providerName: z.string(),
  accountEmail: z.string().nullable(), planLabel: z.string().nullable(),
  windows: z.array(providerLimitWindowSchema),
  status: z.enum(["ok", "error"]), error: z.string().nullable(), lastUpdatedAt: z.string().nullable(),
  machines: z.array(z.object({
    machineId: z.string(), machineName: z.string(),
    agents: z.array(z.object({ id: z.string(), name: z.string() })),
    windows: z.array(providerLimitWindowSchema),
    status: z.enum(["ok", "error"]), error: z.string().nullable(), lastUpdatedAt: z.string().nullable(),
  })),
});
type DashboardRecord = z.infer<typeof usageRecordSchema>;
type SourceState = z.infer<typeof sourceStateSchema>;

export const rpcContract = defineRpcContract({
  dashboard: { input: z.null(), output: z.object({
    mode: z.literal("live"), generatedAt: z.string(), lastSyncedAt: z.string().nullable(), pricingVersion: z.string(),
    machines: z.array(filterOptionSchema), agents: z.array(filterOptionSchema), modelProviders: z.array(filterOptionSchema),
    records: z.array(usageRecordSchema), sources: z.array(sourceStateSchema),
    sync: syncStateSchema, notice: z.string(),
  }) },
  providerLimits: { input: z.null(), output: z.object({
    limits: z.array(providerLimitSchema), accountPoolError: z.string().nullable(),
  }) },
  sync: { input: z.null(), output: z.object({ ok: z.literal(true) }) },
});

type Database = ReturnType<BbPluginApi["storage"]["database"]>;
type Machine = { id: string; name: string };
type CollectorSettings = {
  codexHomes?: string;
  piSessionRoots: string;
  primeSessionRoots: string;
  codexProfileHomes?: string;
  extraUsageRoots?: string;
};

const AGENTS = [
  { id: "amp", name: "Amp" },
  { id: "codex", name: "Codex" },
  { id: "claude", name: "Claude Code" },
  { id: "copilot", name: "GitHub Copilot" },
  { id: "codebuddy", name: "CodeBuddy" },
  { id: "cursor", name: "Cursor Agent" },
  { id: "dsh", name: "DeepSeek Harness" },
  { id: "devin", name: "Devin" },
  { id: "freebuff", name: "Freebuff" },
  { id: "fx", name: "FX" },
  { id: "grok", name: "Grok Agent" },
  { id: "kilocode", name: "Kilo Code" },
  { id: "opencode", name: "OpenCode" },
  { id: "pi", name: "Pi" },
  { id: "prime", name: "Prime Agent" },
  { id: "antigravity", name: "Antigravity" },
  { id: "thaura", name: "Thaura" },
] as const satisfies ReadonlyArray<{ id: AgentId; name: string }>;

const LIMIT_PROVIDERS = [
  { keys: ["codex"], id: "codex", name: "Codex" },
  { keys: ["claude-code", "claudeCode"], id: "claude", name: "Claude Code" },
  { keys: ["acp-cursor", "cursor"], id: "cursor", name: "Cursor" },
] as const;
export const grokLimitsMigration = `CREATE TABLE IF NOT EXISTS grok_limits (
  machine_id TEXT PRIMARY KEY, machine_name TEXT NOT NULL, snapshot_json TEXT,
  fetched_at TEXT, error TEXT
);`;

export async function syncGrokLimits(
  bb: BbPluginApi, db: Database, machine: Machine, signal: AbortSignal,
  executeHostCommand = runHostCommand,
) {
  try {
    const output = await executeHostCommand(bb, machine, grokLimitsCommand(), signal, {
      title: "Usage: Grok Build limits", timeoutMs: 60_000,
    });
    const diagnostic = output.match(/__BB_USAGE_ERROR__:([^\r\n]+)/)?.[1]?.trim();
    if (diagnostic) throw new Error(diagnostic);
    const json = output.match(/__BB_USAGE_BEGIN__\s*([\s\S]*?)\s*__BB_USAGE_END__:0/)?.[1];
    if (!json) throw new Error("Grok billing query returned incomplete output.");
    const snapshot = grokLimitSnapshotSchema.parse(JSON.parse(json));
    if (!snapshot.windows.length) throw new Error("Grok billing response contained no limit windows.");
    db.prepare(`INSERT INTO grok_limits (machine_id, machine_name, snapshot_json, fetched_at, error)
      VALUES (?, ?, ?, ?, NULL) ON CONFLICT(machine_id) DO UPDATE SET
      machine_name=excluded.machine_name, snapshot_json=excluded.snapshot_json, fetched_at=excluded.fetched_at, error=NULL`)
      .run(machine.id, machine.name, JSON.stringify(snapshot), new Date().toISOString());
  } catch (error) {
    const message = errorMessage(error);
    if (message === "no-grok-credential" || message === "no-grok-plan") {
      db.prepare("DELETE FROM grok_limits WHERE machine_id=?").run(machine.id);
      return;
    }
    db.prepare(`INSERT INTO grok_limits (machine_id, machine_name, error) VALUES (?, ?, ?)
      ON CONFLICT(machine_id) DO UPDATE SET machine_name=excluded.machine_name, error=excluded.error`)
      .run(machine.id, machine.name, message);
    bb.log.warn(`${machine.name}/grok: ${message}`);
  }
}

export function loadStoredGrokLimits(db: Database, connectedMachineIds: Set<string>): ProviderLimitSource[] {
  const rows = db.prepare("SELECT * FROM grok_limits ORDER BY machine_name").all() as Array<{
    machine_id: string; machine_name: string; snapshot_json: string | null; fetched_at: string | null; error: string | null;
  }>;
  return rows.filter(row => connectedMachineIds.has(row.machine_id)).flatMap((row): ProviderLimitSource[] => {
    let snapshot: z.infer<typeof grokLimitSnapshotSchema> | null = null;
    let error = row.error;
    try { if (row.snapshot_json) snapshot = grokLimitSnapshotSchema.parse(JSON.parse(row.snapshot_json)); }
    catch { error = "Stored Grok limits could not be read."; }
    // First-time failures remain in stored diagnostics and logs, not empty cards.
    if (!snapshot?.windows.length) return [];
    return [{
      machineId: row.machine_id, machineName: row.machine_name,
      agentId: "grok", agentName: "Grok Build", providerId: "grok", providerName: "Grok Build",
      accountEmail: null, accountIdentity: snapshot?.accountIdentity ?? null, planLabel: null,
      windows: snapshot?.windows ?? [], lastUpdatedAt: row.fetched_at,
      status: error ? "error" : "ok", error,
    }];
  });
}

const PROVIDER_LIMITS_TIMEOUT_MS = 5_000;
const DASHBOARD_HOSTS_TIMEOUT_MS = 5_000;
const SYNC_HOSTS_TIMEOUT_MS = 10_000;
const HOST_DIRECTORY_TIMEOUT_MS = 10_000;
const JSON_AGENT_SYNC_TIMEOUT_MS = 10 * 60_000;
const AMP_SYNC_TIMEOUT_MS = 10 * 60_000;
const DEVIN_SYNC_TIMEOUT_MS = 60_000;
const KILOCODE_SYNC_TIMEOUT_MS = 60_000;
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
): Promise<ProviderLimitSource[]> {
  const machineRows = await Promise.all(machines.filter((candidate) => candidate.status === "connected").map(async (machine) => {
    const rows: ProviderLimitSource[] = [];
    const presentRows = db.prepare(`SELECT DISTINCT s.provider_id agentId FROM usage_sources s
      JOIN usage_event_sources es ON es.source_id = s.source_id
      WHERE s.machine_id = ? AND s.provider_id IN (?, ?, ?)`)
      .all(machine.id, "codex", "claude", "cursor") as Array<{ agentId: string }>;
    const present = new Set(presentRows.map((row) => row.agentId));
    try {
      const usage = await bb.sdk.system.usageLimits({ hostId: machine.id, signal: AbortSignal.timeout(timeoutMs) });
      rows.push(...LIMIT_PROVIDERS.flatMap((provider): ProviderLimitSource[] => {
        const limit = provider.keys.map((key) => usage[key]).find((candidate) => candidate !== undefined);
        if (!limit) return [];
        const source = {
          machineId: machine.id,
          machineName: machine.name,
          agentId: provider.id,
          agentName: provider.name,
          providerId: provider.id,
          providerName: provider.name,
          accountEmail: typeof limit.accountEmail === "string" ? limit.accountEmail : null,
          accountIdentity: null,
          planLabel: typeof limit.planLabel === "string" ? limit.planLabel : null,
        };
        if (limit.status === "ok") {
          if (limit.windows.length === 0) return [];
          return [{ ...source, windows: limit.windows, status: "ok" as const, error: null, lastUpdatedAt: null }];
        }
        if (limit.status === "error") {
          bb.log.debug(`Provider limits unavailable for ${provider.name} on ${machine.name}: ${limit.message}`);
          return [{ ...source, windows: [], status: "error" as const, error: limit.message, lastUpdatedAt: null }];
        }
        return [];
      }));
    } catch (error) {
      const message = `Provider limits unavailable: ${errorMessage(error)}`;
      bb.log.debug(`Provider limits unavailable for ${machine.name}: ${errorMessage(error)}`);
      rows.push(...LIMIT_PROVIDERS
        .filter((provider) => present.has(provider.id))
        .map((provider): ProviderLimitSource => ({
          machineId: machine.id,
          machineName: machine.name,
          agentId: provider.id,
          agentName: provider.name,
          providerId: provider.id,
          providerName: provider.name,
          accountEmail: null,
          accountIdentity: null,
          planLabel: null,
          windows: [],
          status: "error",
          error: message,
          lastUpdatedAt: null,
        })));
    }
    return rows;
  }));
  return machineRows.flat();
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
const openCodeGoFingerprintMigration = `
ALTER TABLE opencode_go_limits ADD COLUMN account_fingerprint TEXT;`;
const codexAttributionMigration = `ALTER TABLE usage_sources ADD COLUMN attribution TEXT;`;

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

// Entries are `name=path` or a bare CODEX_HOME path whose basename becomes the
// account label; a home literally named "codex" stays untagged so a relocated
// primary home merges into the base Codex agent. A `=` only separates a label
// when the prefix is pathless, so a bare path containing "=" still parses.
function codexAccountHomes(value: string, home: string): Array<{ account: string; home: string }> {
  const seen = new Set<string>();
  const homes: Array<{ account: string; home: string }> = [];
  for (const part of value.split(/[;\n]/)) {
    const separator = part.indexOf("=");
    const named = separator > 0 && !part.slice(0, separator).includes("/");
    const resolved = normalizeRoot(expandHome(named ? part.slice(separator + 1) : part, home));
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    const account = (named ? part.slice(0, separator).trim() : resolved.slice(resolved.lastIndexOf("/") + 1)).slice(0, 80);
    homes.push({ account: account === "codex" ? "" : account, home: resolved });
  }
  return homes;
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

// Offline repair only: callers must establish the complete historical event
// population from SDK evidence and keep v2 corrections available on the host.
// A successful scan alone is not proof that a retained bucket can be reduced.
export function repairCursorSdkBuckets(db: Database, sourceId: string, pairs: Array<{ before: UsageRecord; after: UsageRecord }>) {
  const source = db.prepare("SELECT machine_id machineId, provider_id agentId FROM usage_sources WHERE source_id=?")
    .get(sourceId) as { machineId: string; agentId: string } | undefined;
  if (source?.agentId !== "cursor") throw new Error("Repair requires a Cursor source.");
  activateCachedCatalog(db);
  const select = db.prepare(`SELECT uncached_input_tokens input, cached_input_tokens cached,
    cache_write_tokens writes, output_tokens output, processed_tokens total FROM usage_events
    WHERE event_key=? AND provider_id='cursor' AND EXISTS
      (SELECT 1 FROM usage_event_sources WHERE event_key=usage_events.event_key AND source_id=?)`);
  const update = db.prepare(`UPDATE usage_events SET uncached_input_tokens=?, processed_tokens=?,
    cost_usd=?, cache_savings_usd=?, pricing_status=? WHERE event_key=?`);
  return db.transaction(() => {
    let repaired = 0;
    for (const { before, after } of pairs) {
      if (before.agentId !== "cursor" || after.agentId !== "cursor"
        || before.machineId !== source.machineId || after.machineId !== source.machineId
        || before.eventKey !== after.eventKey || before.day !== after.day
        || before.model !== after.model || before.modelProviderId !== after.modelProviderId
        || before.project !== after.project || before.loggedCostUsd !== after.loggedCostUsd
        || after.uncachedInputTokens >= before.uncachedInputTokens
        || before.cachedInputTokens !== after.cachedInputTokens
        || before.cacheWriteTokens !== after.cacheWriteTokens || before.outputTokens !== after.outputTokens) {
        throw new Error("Invalid Cursor SDK repair pair.");
      }
      const tuple = (row: UsageRecord) => ({ input: row.uncachedInputTokens, cached: row.cachedInputTokens,
        writes: row.cacheWriteTokens, output: row.outputTokens, total: row.processedTokens });
      const current = select.get(before.eventKey, sourceId);
      if (JSON.stringify(current) === JSON.stringify(tuple(after))) continue;
      if (JSON.stringify(current) !== JSON.stringify(tuple(before))) throw new Error("Cursor bucket changed; repair aborted.");
      const priced = repriceUsageRecord(after);
      update.run(priced.uncachedInputTokens, priced.processedTokens, priced.costUsd,
        priced.cacheSavingsUsd, priced.pricingStatus, priced.eventKey);
      repaired++;
    }
    return repaired;
  })();
}

function upsertSourceEvents(db: Database, source: { id: string; rootReference: string; sha256: string; generation: string }, machine: Machine, agentId: AgentId, records: UsageRecord[]) {
  const insertEvent = db.prepare(`INSERT INTO usage_events (
      event_key, timestamp, day, provider_id, provider_name, model, cost_usd, cache_savings_usd,
      processed_tokens, cached_input_tokens, cache_write_tokens, uncached_input_tokens, output_tokens,
      model_provider_id, model_provider_name, logged_cost_usd, pricing_status, project
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_key) DO UPDATE SET timestamp=excluded.timestamp, day=excluded.day, provider_id=excluded.provider_id,
    provider_name=excluded.provider_name, model=excluded.model, project=excluded.project,
    cost_usd=excluded.cost_usd, cache_savings_usd=excluded.cache_savings_usd,
    processed_tokens=MAX(cached_input_tokens, excluded.cached_input_tokens)
      + MAX(cache_write_tokens, excluded.cache_write_tokens)
      + MAX(uncached_input_tokens, excluded.uncached_input_tokens)
      + MAX(output_tokens, excluded.output_tokens),
    cached_input_tokens=MAX(cached_input_tokens, excluded.cached_input_tokens),
    cache_write_tokens=MAX(cache_write_tokens, excluded.cache_write_tokens),
    uncached_input_tokens=MAX(uncached_input_tokens, excluded.uncached_input_tokens),
    output_tokens=MAX(output_tokens, excluded.output_tokens),
    -- Logged costs are authoritative vendor figures: always take the newest,
    -- so price corrections (up or down) flow through instead of freezing at
    -- the first observed value.
    logged_cost_usd=excluded.logged_cost_usd,
    model_provider_id=excluded.model_provider_id, model_provider_name=excluded.model_provider_name,
    pricing_status=excluded.pricing_status`);
  const insertMapping = db.prepare("INSERT OR IGNORE INTO usage_event_sources (event_key, source_id) VALUES (?, ?)");

  db.transaction(() => {
    db.prepare(`INSERT INTO usage_sources (source_id, machine_id, machine_name, provider_id, root_reference, content_sha, last_seen_generation, last_success_at, pricing_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET
      machine_name=excluded.machine_name, root_reference=excluded.root_reference, content_sha=excluded.content_sha,
      last_seen_generation=excluded.last_seen_generation, last_success_at=excluded.last_success_at, pricing_version=excluded.pricing_version`)
      .run(source.id, machine.id, machine.name, agentId, source.rootReference, source.sha256, source.generation, new Date().toISOString(), pricingRevision());
    // A rescan adds observed keys; absence does not erase recorded history.
    for (const row of records) {
      insertEvent.run(
        row.eventKey, row.timestamp, row.day, row.agentId, row.agentName, row.model, row.costUsd, row.cacheSavingsUsd,
        row.processedTokens, row.cachedInputTokens, row.cacheWriteTokens, row.uncachedInputTokens, row.outputTokens,
        row.modelProviderId, row.modelProviderName, row.loggedCostUsd, row.pricingStatus, row.project,
      );
      insertMapping.run(row.eventKey, source.id);
    }
    // Bound retained history by age instead of scan completeness.
    db.prepare(`DELETE FROM usage_event_sources WHERE source_id=? AND event_key IN
      (SELECT event_key FROM usage_events WHERE day < ?)`)
      .run(source.id, historyStartDay(agentId === "opencode" ? OPENCODE_HISTORY_DAYS : HISTORY_DAYS));
    deleteOrphanEvents(db);

    // Reprice all retained rows, including those absent from the latest scan.
    const retained = db.prepare(`SELECT e.event_key eventKey, e.timestamp, e.day,
      e.provider_id agentId, e.provider_name agentName, e.model_provider_id modelProviderId,
      e.model_provider_name modelProviderName, s.machine_id machineId, s.machine_name machineName,
      e.model, e.project, e.cost_usd costUsd, e.logged_cost_usd loggedCostUsd,
      e.pricing_status pricingStatus, e.cache_savings_usd cacheSavingsUsd,
      e.processed_tokens processedTokens, e.cached_input_tokens cachedInputTokens,
      e.cache_write_tokens cacheWriteTokens, e.uncached_input_tokens uncachedInputTokens,
      e.output_tokens outputTokens FROM usage_events e
      JOIN usage_event_sources es ON es.event_key=e.event_key
      JOIN usage_sources s ON s.source_id=es.source_id WHERE es.source_id=?`)
      .all(source.id) as UsageRecord[];
    const updatePrice = db.prepare(`UPDATE usage_events SET cost_usd=?, cache_savings_usd=?,
      pricing_status=? WHERE event_key=?`);
    for (const record of retained) {
      const priced = repriceUsageRecord(record);
      updatePrice.run(priced.costUsd, priced.cacheSavingsUsd, priced.pricingStatus, record.eventKey);
    }
  })();
}

// The last-seen home tag→label map is persisted on the scan's source row so a
// rename (same home, different label) can be told apart from an added or
// removed profile. Entries for removed homes are kept, so re-adding the home
// under a new label is still recognised as a rename of its retained history.
// Snapshots written before keys were tags hold raw home paths; they fold into
// tags so a rename recorded by an intermediate build still resolves.
function codexAttributionSnapshot(stored: string | null | undefined, current: Map<string, string>) {
  const merged: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(stored ?? "{}");
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [home, account] of Object.entries(parsed)) {
        if (typeof account === "string") merged[home.includes("/") ? codexHomeTag(home) : home] = account;
      }
    }
  } catch { /* An unreadable snapshot just means no renames can be proven. */ }
  for (const [tag, account] of current) merged[tag] = account;
  return merged;
}

type CodexBucketRow = {
  eventKey: string; agentId: string; processedTokens: number; cachedInputTokens: number; cacheWriteTokens: number;
  uncachedInputTokens: number; outputTokens: number; loggedCostUsd: number | null;
  costUsd: number; cacheSavingsUsd: number;
};

const codexBucketRowColumns = `e.event_key eventKey, e.provider_id agentId, e.processed_tokens processedTokens,
  e.cached_input_tokens cachedInputTokens, e.cache_write_tokens cacheWriteTokens,
  e.uncached_input_tokens uncachedInputTokens, e.output_tokens outputTokens,
  e.logged_cost_usd loggedCostUsd, e.cost_usd costUsd, e.cache_savings_usd cacheSavingsUsd`;

// Applies key rewrites with the same per-column MAX merge insertEvent uses,
// so folding a renamed or newly-tagged row into an existing bucket mirrors
// how a rescan would merge the same content. `drop` removes a row entirely:
// an untagged bucket that several tagged siblings now split is unassignable
// and already covered by the fresh scan, so keeping it would double count.
// Merged buckets are repriced afterwards: the folded column maxima can total
// more than either input row, so keeping a merged cost would understate it.
function applyCodexKeyRewrites(db: Database, sourceId: string, rewrites: Array<{ key: string; nextKey?: string; to?: string; row: CodexBucketRow; drop?: boolean }>) {
  if (rewrites.length === 0) return;
  const targetRow = db.prepare(`SELECT event_key eventKey, processed_tokens processedTokens,
    cached_input_tokens cachedInputTokens, cache_write_tokens cacheWriteTokens,
    uncached_input_tokens uncachedInputTokens, output_tokens outputTokens,
    logged_cost_usd loggedCostUsd, cost_usd costUsd, cache_savings_usd cacheSavingsUsd
    FROM usage_events WHERE event_key=?`);
  const mergeInto = db.prepare(`UPDATE usage_events SET
      processed_tokens=?, cached_input_tokens=?, cache_write_tokens=?, uncached_input_tokens=?,
      output_tokens=?, logged_cost_usd=?
    WHERE event_key=?`);
  const relabel = db.prepare("UPDATE usage_events SET event_key=?, provider_id=?, provider_name=? WHERE event_key=?");
  const carryMappings = db.prepare("INSERT OR IGNORE INTO usage_event_sources (event_key, source_id) SELECT ?, source_id FROM usage_event_sources WHERE event_key=?");
  const dropMappings = db.prepare("DELETE FROM usage_event_sources WHERE event_key=?");
  const dropEvent = db.prepare("DELETE FROM usage_events WHERE event_key=?");
  // Same record shape upsertSourceEvents uses to reprice retained rows.
  const recordFor = db.prepare(`SELECT e.event_key eventKey, e.timestamp, e.day,
    e.provider_id agentId, e.provider_name agentName, e.model_provider_id modelProviderId,
    e.model_provider_name modelProviderName, s.machine_id machineId, s.machine_name machineName,
    e.model, e.project, e.cost_usd costUsd, e.logged_cost_usd loggedCostUsd,
    e.pricing_status pricingStatus, e.cache_savings_usd cacheSavingsUsd,
    e.processed_tokens processedTokens, e.cached_input_tokens cachedInputTokens,
    e.cache_write_tokens cacheWriteTokens, e.uncached_input_tokens uncachedInputTokens,
    e.output_tokens outputTokens FROM usage_events e
    JOIN usage_event_sources es ON es.event_key=e.event_key
    JOIN usage_sources s ON s.source_id=es.source_id
    WHERE e.event_key=? AND es.source_id=?`);
  const updatePrice = db.prepare(`UPDATE usage_events SET cost_usd=?, cache_savings_usd=?,
    pricing_status=? WHERE event_key=?`);

  db.transaction(() => {
    const mergedKeys: string[] = [];
    for (const { key, nextKey, to, row, drop } of rewrites) {
      if (drop) {
        dropMappings.run(key);
        dropEvent.run(key);
        continue;
      }
      const target = targetRow.get(nextKey!) as CodexBucketRow | undefined;
      if (target) {
        // The new label already owns the bucket: fold the row into it. Totals
        // follow the merged per-column maxima, as insertEvent computes them.
        const cached = Math.max(target.cachedInputTokens, row.cachedInputTokens);
        const writes = Math.max(target.cacheWriteTokens, row.cacheWriteTokens);
        const uncached = Math.max(target.uncachedInputTokens, row.uncachedInputTokens);
        const output = Math.max(target.outputTokens, row.outputTokens);
        const logged = row.loggedCostUsd === null ? target.loggedCostUsd
          : target.loggedCostUsd === null ? row.loggedCostUsd
            : Math.max(target.loggedCostUsd, row.loggedCostUsd);
        mergeInto.run(cached + writes + uncached + output, cached, writes, uncached, output, logged, nextKey!);
        mergedKeys.push(nextKey!);
      } else {
        relabel.run(nextKey!, to!, to === "codex" ? "Codex" : `Codex (${to!.slice(6)})`, key);
      }
      carryMappings.run(nextKey!, key);
      dropMappings.run(key);
      dropEvent.run(key);
    }
    for (const key of mergedKeys) {
      const record = recordFor.get(key, sourceId) as UsageRecord | undefined;
      if (record === undefined) continue;
      const priced = repriceUsageRecord(record);
      updatePrice.run(priced.costUsd, priced.cacheSavingsUsd, priced.pricingStatus, key);
    }
  })();
}

// Rewrites rows produced by a renamed profile home to the new label. The
// bucket key's trailing home tag scopes the rewrite to that home only, so
// homes sharing a label and unlabeled homes never have their buckets moved
// wholesale. Attribution is keyed by home tag so convention-discovered homes
// rename exactly like configured ones.
function relabelRenamedCodexAccounts(db: Database, sourceId: string, attribution: Map<string, string>) {
  const source = db.prepare("SELECT attribution FROM usage_sources WHERE source_id=?").get(sourceId) as { attribution: string | null } | undefined;
  const previous = codexAttributionSnapshot(source?.attribution, new Map());
  const renames: Array<{ tag: string; from: string; to: string }> = [];
  for (const [tag, account] of attribution) {
    const before = previous[tag];
    if (before !== undefined && before !== account) {
      renames.push({ tag, from: before ? `codex-${before}` : "codex", to: account ? `codex-${account}` : "codex" });
    }
  }
  if (renames.length === 0) return;

  const staleRows = db.prepare(`SELECT ${codexBucketRowColumns}
    FROM usage_events e JOIN usage_event_sources es ON es.event_key=e.event_key
    WHERE es.source_id=? AND substr(e.event_key, 1, ?) = ? AND substr(e.event_key, -13) = ?`);
  const stageEvent = db.prepare("UPDATE usage_events SET event_key=? WHERE event_key=?");
  const stageMapping = db.prepare("UPDATE usage_event_sources SET event_key=? WHERE event_key=?");

  db.transaction(() => {
    // Stage every renamed row under a sentinel key before any final write:
    // rows produced by an earlier rename must not be picked up again when
    // labels chain (A→B and B→C) or swap (A→B and B→A) in one config edit.
    const staged: Array<{ stagedKey: string; nextKey: string; to: string; row: CodexBucketRow }> = [];
    for (const { tag, from, to } of renames) {
      const prefix = `${from}:`;
      for (const row of staleRows.all(sourceId, prefix.length, prefix, `:${tag}`) as CodexBucketRow[]) {
        if (row.eventKey.slice(prefix.length).split(":").length !== 6) continue;
        const stagedKey = `\0relabel:${row.eventKey}`;
        stageEvent.run(stagedKey, row.eventKey);
        stageMapping.run(stagedKey, row.eventKey);
        staged.push({ stagedKey, nextKey: `${to}:${row.eventKey.slice(prefix.length)}`, to, row });
      }
    }
    applyCodexKeyRewrites(db, sourceId, staged.map(({ stagedKey, nextKey, to, row }) => ({ key: stagedKey, nextKey, to, row })));
  })();
}

// Rows persisted before keys carried a home tag get one appended when their
// label resolves to exactly one known home — configured or observed by the
// scan — with the primary home as the fallback for the unlabeled prefix.
// Legacy rows whose label resolves to several homes are already represented
// by tagged siblings. Adopted rows whose label resolves to no home are
// upgrade leftovers:
// a single tagged sibling (a renamed home still emitting the same bucket)
// absorbs the row, while several siblings prove the old bucket merged content
// the fresh scan already splits, so the untagged row is dropped rather than
// double counted. Other unresolvable stable-source rows retain their history.
function normalizeCodexHomeKeys(db: Database, sourceId: string, attribution: Map<string, string>, primaryHomeTag: string, adoptedKeys: Set<string>) {
  const tagsByLabel = new Map<string, string[]>();
  for (const [tag, account] of attribution) {
    const list = tagsByLabel.get(account) ?? [];
    list.push(tag);
    tagsByLabel.set(account, list);
  }
  const rows = db.prepare(`SELECT ${codexBucketRowColumns}
    FROM usage_events e JOIN usage_event_sources es ON es.event_key=e.event_key WHERE es.source_id=?`)
    .all(sourceId) as CodexBucketRow[];
  const taggedSiblings = db.prepare(`SELECT DISTINCT event_key eventKey FROM usage_events
    WHERE instr(event_key, ?) > 0 AND event_key <> ?
      AND (provider_id='codex' OR provider_id LIKE 'codex-%')`);
  const rewrites: Array<{ key: string; nextKey?: string; to?: string; row: CodexBucketRow; drop?: boolean }> = [];
  for (const row of rows) {
    // The account label may contain colons, but components after the agent id
    // are URI encoded. A project can look like a twelve-character home tag.
    if (row.eventKey.slice(row.agentId.length + 1).split(":").length !== 5) continue;
    const label = row.eventKey.startsWith("codex:") ? "" : row.eventKey.startsWith("codex-") ? row.eventKey.slice(6, row.eventKey.indexOf(":")) : null;
    if (label === null) continue;
    const candidates = label === "" ? (tagsByLabel.get("") ?? [primaryHomeTag]) : (tagsByLabel.get(label) ?? []);
    if (candidates.length === 1) {
      rewrites.push({ key: row.eventKey, nextKey: `${row.eventKey}:${candidates[0]}`, to: label ? `codex-${label}` : "codex", row });
      continue;
    }
    if (candidates.length === 0 && !adoptedKeys.has(row.eventKey)) continue;
    const siblings = taggedSiblings.all(`${row.eventKey.slice(row.eventKey.indexOf(":"))}:`, row.eventKey) as Array<{ eventKey: string }>;
    if (siblings.length === 1) {
      if (adoptedKeys.has(row.eventKey)) rewrites.push({ key: row.eventKey, nextKey: siblings[0].eventKey, row });
    } else if (siblings.length > 1) {
      rewrites.push({ key: row.eventKey, row, drop: true });
    }
  }
  applyCodexKeyRewrites(db, sourceId, rewrites);
}

// Builds before source attribution put the whole Codex scan on a
// config-derived source id, so its replacements delete the old source. Adopt
// any such leftover source's event mappings into the stable scan source to
// keep its retained history alive, and return the adopted event keys so the
// caller can treat their unresolvable buckets as upgrade leftovers.
function adoptLegacyCodexSources(db: Database, machineId: string, sourceId: string) {
  const legacy = db.prepare(`SELECT source_id id FROM usage_sources
    WHERE machine_id=? AND provider_id='codex' AND source_id<>` + "?")
    .all(machineId, sourceId) as Array<{ id: string }>;
  const adopted = new Set<string>();
  db.transaction(() => {
    for (const { id } of legacy) {
      for (const { key } of db.prepare("SELECT event_key key FROM usage_event_sources WHERE source_id=?").all(id) as Array<{ key: string }>) {
        adopted.add(key);
      }
      db.prepare(`INSERT OR IGNORE INTO usage_event_sources (event_key, source_id)
        SELECT event_key, ? FROM usage_event_sources WHERE source_id=?`).run(sourceId, id);
      db.prepare("DELETE FROM usage_event_sources WHERE source_id=?").run(id);
      db.prepare("DELETE FROM usage_sources WHERE source_id=?").run(id);
    }
  })();
  return adopted;
}

function deleteOrphanEvents(db: Database) {
  db.prepare("DELETE FROM usage_events WHERE event_key NOT IN (SELECT event_key FROM usage_event_sources)").run();
}

function reconcileSources(db: Database, machineId: string, agentId: AgentId, generation: string) {
  db.transaction(() => {
    const stale = db.prepare("SELECT source_id id FROM usage_sources WHERE machine_id=? AND provider_id=? AND last_seen_generation<>?")
      .all(machineId, agentId, generation) as Array<{ id: string }>;
    for (const source of stale) {
      db.prepare("DELETE FROM usage_event_sources WHERE source_id=?").run(source.id);
      db.prepare("DELETE FROM usage_sources WHERE source_id=?").run(source.id);
    }
    deleteOrphanEvents(db);
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
    db.prepare(`DELETE FROM grok_limits WHERE machine_id NOT IN (${placeholders})`).run(...machineIds);
    db.prepare(`DELETE FROM opencode_go_limits WHERE machine_id NOT IN (${placeholders})`).run(...machineIds);
    db.prepare(`DELETE FROM opencode_go_limit_state WHERE machine_id NOT IN (${placeholders})`).run(...machineIds);
    deleteOrphanEvents(db);
  })();
}

export function jsonAgentRoots(home: string, agentId: HostJsonAgentId, settings: CollectorSettings) {
  if (agentId === "codex") {
    const homes = [...new Set([`${home}/.codex`, ...configuredRoots(settings.codexHomes ?? "", home)])];
    return homes.flatMap((root) => [`${root}/sessions`, `${root}/archived_sessions`]);
  }
  const resolvedPrimeRoots = primeRoots(home, settings.primeSessionRoots);
  const defaults = agentId === "claude" ? [`${home}/.claude/projects`]
    : agentId === "copilot" ? [`${home}/.copilot/session-state`]
    : agentId === "codebuddy" ? [`${home}/.codebuddy/projects`]
    : agentId === "cursor" ? [`${home}/.cursor/usage.jsonl`]
    : agentId === "dsh" ? [`${home}/.dsh/sessions`]
    : agentId === "freebuff" ? [`${home}/.freebuff`]
    : agentId === "fx" ? [`${home}/.fx/usage.jsonl`]
    : agentId === "grok" ? [`${home}/.grok/logs`]
    : agentId === "antigravity" ? [`${home}/.antigravity-acp/usage.jsonl`]
    : agentId === "thaura" ? [`${home}/.thaura/usage.jsonl`]
    : agentId === "prime" ? resolvedPrimeRoots
    : [`${home}/.pi/agent/sessions`, `${home}/.bb/pi-bridge-sessions`, ...configuredRoots(settings.piSessionRoots, home).filter((root) => {
      const defaultPrimeAgentRoot = `${home}/.prime/agent`;
      return root !== defaultPrimeAgentRoot && !resolvedPrimeRoots.includes(root);
    })];
  let extra;
  try { extra = JSON.parse(settings.extraUsageRoots?.trim() || "{}"); }
  catch { throw new Error("Extra usage roots must be valid JSON."); }
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) throw new Error("Extra usage roots must be a JSON object.");
  const roots = extra[agentId] ?? [];
  if (!Array.isArray(roots) || !roots.every((root) => typeof root === "string" && /^(\/|~\/|[A-Za-z]:[\\/])/.test(root))) {
    throw new Error("Extra usage roots must contain arrays of absolute paths or ~/ paths.");
  }
  return [...new Set([...defaults, ...roots.map((root: string) => normalizeRoot(expandHome(root, home)))])];
}

function historyStartDay(days = HISTORY_DAYS) {
  const start = new Date();
  start.setDate(start.getDate() - days);
  return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
}

export function jsonAgentCommand(input: Parameters<typeof compressedHostJsonCollectorScript>[0]) {
  const script = compressedHostJsonCollectorScript(input);
  return [
    "if ! command -v node >/dev/null 2>&1",
    "then printf '%s\\n' '__BB_USAGE_ERROR__:Node.js is required to scan agent usage logs.'; exit 127",
    "fi",
    `node -e ${shellQuote(script)}`,
  ].join("; ");
}

export function ampUsageCommand(home: string) {
  const script = compressedAmpUsageCollectorScript({
    cachePath: `${home}/.cache/bb-plugin-usage/amp-thread-scan-v1.json`,
    sinceDay: historyStartDay(),
  });
  return [
    "if ! command -v node >/dev/null 2>&1",
    "then printf '%s\\n' '__BB_USAGE_ERROR__:Node.js is required to scan Amp usage.'; exit 127",
    "fi",
    "if ! command -v amp >/dev/null 2>&1",
    "then printf '%s\\n' '__BB_USAGE_ERROR__:Amp CLI is required to collect Amp usage.'; exit 127",
    "fi",
    `node -e ${shellQuote(script)}`,
  ].join("; ");
}

export async function syncAmp(
  bb: BbPluginApi,
  db: Database,
  machine: Machine,
  home: string,
  signal: AbortSignal,
  executeHostCommand = runHostCommand,
) {
  const agentId: AgentId = "amp";
  const generation = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const output = await executeHostCommand(bb, machine, ampUsageCommand(home), signal, {
      title: "Usage: Amp scan",
      timeoutMs: AMP_SYNC_TIMEOUT_MS,
      home,
    });
    const scan = extractAmpUsageScan(output);
    if (scan.agentId !== agentId) throw new Error(`Amp usage scan returned ${scan.agentId} data.`);

    // A partial scan must not delete a thread whose export failed. Mark prior
    // sources seen first; complete scans still reconcile threads no longer in
    // the account or retention window.
    if (scan.failureCount > 0) {
      db.prepare("UPDATE usage_sources SET last_seen_generation=? WHERE machine_id=? AND provider_id=?")
        .run(generation, machine.id, agentId);
    }
    for (const thread of scan.threads) {
      const records = parseAmpUsageAggregates(thread.rows, {
        machineId: machine.id,
        machineName: machine.name,
      });
      const aggregateJson = JSON.stringify(thread.rows);
      upsertSourceEvents(db, {
        id: opaqueId(machine.id, agentId, thread.threadId),
        rootReference: opaqueId("amp-thread", thread.threadId),
        sha256: createHash("sha256").update(aggregateJson).digest("hex"),
        generation,
      }, machine, agentId, records);
    }
    reconcileSources(db, machine.id, agentId, generation);

    const recordCount = countForMachine(db, machine.id, agentId);
    const complete = scan.failureCount === 0;
    const status = !complete ? "partial" : recordCount > 0 ? "ready" : "no-data";
    const error = complete ? null
      : `${scan.failureCount} Amp thread problem${scan.failureCount === 1 ? "" : "s"} prevented a complete scan${scan.error ? `: ${scan.error}` : "."}`;
    upsertState(db, machine.id, agentId, status, recordCount, error, complete);
    bb.log.info(`${machine.name}/amp: ${recordCount} records from ${scan.threadCount} threads (${scan.changedThreadCount} changed, ${scan.reusedThreadCount} cached, ${status})`);
  } catch (error) {
    const recordCount = countForMachine(db, machine.id, agentId);
    const message = errorMessage(error);
    if (message.includes("Amp CLI is required")) {
      upsertState(db, machine.id, agentId, "skipped", recordCount, message, false);
      bb.log.info(`${machine.name}/amp: skipped (no local Amp CLI)`);
    } else {
      upsertState(db, machine.id, agentId, "unavailable", recordCount, message, false);
      bb.log.warn(`${machine.name}/amp: ${message}`);
    }
  }
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
    // Extra Codex accounts keep CODEX_HOME in per-account homes: the
    // ~/.codex-profiles/<name> and ~/.codex-<name> conventions plus any
    // configured homes. The scan tags their rows with the account name so
    // each account stays a distinct agent.
    const accountRoots = agentId === "codex"
      ? [{ root: `${home}/.codex-profiles` }, { root: home, prefix: ".codex-" }]
      : undefined;
    const accountHomes = agentId === "codex" ? codexAccountHomes(settings.codexProfileHomes ?? "", home) : undefined;
    const output = await runHostCommand(bb, machine, jsonAgentCommand({
      agentId,
      roots,
      cachePath,
      sinceDay: historyStartDay(),
      accountRoots,
      accountHomes,
    }), signal, {
      title: `Usage: ${agentId} scan`,
      timeoutMs: JSON_AGENT_SYNC_TIMEOUT_MS,
      home,
    });
    const scan = extractHostJsonScan(output);
    if (scan.agentId !== agentId) throw new Error(`Host usage scan returned ${scan.agentId} data for ${agentId}.`);
    const aggregateJson = JSON.stringify(scan.rows);
    const records = parseHostUsageAggregates(aggregateJson, agentId, {
      machineId: machine.id,
      machineName: machine.name,
    });
    // Preserve the original Codex source identity as archive and custom roots
    // are added, so reconciliation keeps history whose logs are no longer present.
    const sourceRoots = agentId === "codex" ? [`${home}/.codex/sessions`] : roots;
    const sourceId = opaqueId(machine.id, agentId, "host-json-scan-v1", ...sourceRoots);
    // Home tag → label for this scan: the collector reports every home it
    // observed (including convention-discovered ones); configured homes win
    // ties because their explicit label outranks a conventional one.
    const codexAttribution = new Map<string, string>();
    for (const entry of scan.homes ?? []) codexAttribution.set(entry.homeTag, entry.account);
    for (const { home, account } of accountHomes ?? []) codexAttribution.set(codexHomeTag(home), account);
    // A renamed profile label rewrites its rows' keys/provider in place: the
    // source stays stable, so retained history survives and the new label's
    // rows merge into the relabeled buckets instead of duplicating them.
    if (agentId === "codex") relabelRenamedCodexAccounts(db, sourceId, codexAttribution);
    upsertSourceEvents(db, {
      id: sourceId,
      rootReference: opaqueId(...roots),
      sha256: createHash("sha256").update(aggregateJson).digest("hex"),
      generation,
    }, machine, agentId, records);
    if (agentId === "codex") {
      const adoptedKeys = adoptLegacyCodexSources(db, machine.id, sourceId);
      normalizeCodexHomeKeys(db, sourceId, codexAttribution, codexHomeTag(`${home}/.codex`), adoptedKeys);
      db.prepare("UPDATE usage_sources SET attribution=? WHERE source_id=?")
        .run(JSON.stringify(codexAttributionSnapshot(
          (db.prepare("SELECT attribution FROM usage_sources WHERE source_id=?").get(sourceId) as { attribution: string | null } | undefined)?.attribution,
          codexAttribution)), sourceId);
    }
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

export function devinCommand(home: string) {
  const script = compressedDevinCollectorScript({
    agentId: "devin",
    dbPaths: [
      `${home}/.local/share/devin/cli/sessions.db`,
      `${home}/Library/Application Support/devin/cli/sessions.db`,
    ],
    sinceDay: historyStartDay(),
  });
  return [
    "if ! command -v node >/dev/null 2>&1",
    "then printf '%s\\n' '__BB_USAGE_ERROR__:Node.js is required to scan Devin usage.'; exit 127",
    "fi",
    `node -e ${shellQuote(script)}`,
  ].join("; ");
}

export async function syncDevin(
  bb: BbPluginApi,
  db: Database,
  machine: Machine,
  home: string,
  signal: AbortSignal,
  executeHostCommand = runHostCommand,
) {
  const agentId: AgentId = "devin";
  const generation = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const output = await executeHostCommand(bb, machine, devinCommand(home), signal, {
      title: "Usage: Devin scan",
      timeoutMs: DEVIN_SYNC_TIMEOUT_MS,
    });
    const scan = extractHostJsonScan(output);
    if (scan.agentId !== agentId) throw new Error(`Host usage scan returned ${scan.agentId} data for ${agentId}.`);
    const aggregateJson = JSON.stringify(scan.rows);
    const records = parseHostUsageAggregates(aggregateJson, agentId, {
      machineId: machine.id,
      machineName: machine.name,
    });
    const sourceId = opaqueId(machine.id, agentId, "devin-sqlite-v1");
    upsertSourceEvents(db, {
      id: sourceId,
      rootReference: opaqueId("devin-cli-sessions-db"),
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
    bb.log.info(`${machine.name}/${agentId}: ${recordCount} records from Devin sessions.db (${status})`);
  } catch (error) {
    const recordCount = countForMachine(db, machine.id, agentId);
    const message = `Usage scan failed: ${errorMessage(error)}`;
    upsertState(db, machine.id, agentId, "unavailable", recordCount, message, false);
    bb.log.warn(`${machine.name}/${agentId}: ${message}`);
  }
}

export function kilocodeCommand(home: string) {
  const script = compressedKilocodeCollectorScript({
    agentId: "kilocode",
    dbPaths: [
      `${home}/.local/share/kilo/kilo.db`,
      `${home}/Library/Application Support/kilo/kilo.db`,
    ],
    sinceDay: historyStartDay(),
  });
  return [
    "if ! command -v node >/dev/null 2>&1",
    "then printf '%s\\n' '__BB_USAGE_ERROR__:Node.js is required to scan Kilo Code usage.'; exit 127",
    "fi",
    `node -e ${shellQuote(script)}`,
  ].join("; ");
}

export async function syncKilocode(
  bb: BbPluginApi,
  db: Database,
  machine: Machine,
  home: string,
  signal: AbortSignal,
  executeHostCommand = runHostCommand,
) {
  const agentId: AgentId = "kilocode";
  const generation = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const output = await executeHostCommand(bb, machine, kilocodeCommand(home), signal, {
      title: "Usage: Kilo Code scan",
      timeoutMs: KILOCODE_SYNC_TIMEOUT_MS,
    });
    const scan = extractHostJsonScan(output);
    if (scan.agentId !== agentId) throw new Error(`Host usage scan returned ${scan.agentId} data for ${agentId}.`);
    const aggregateJson = JSON.stringify(scan.rows);
    const records = parseHostUsageAggregates(aggregateJson, agentId, {
      machineId: machine.id,
      machineName: machine.name,
    });
    const sourceId = opaqueId(machine.id, agentId, "kilocode-sqlite-v1");
    upsertSourceEvents(db, {
      id: sourceId,
      rootReference: opaqueId("kilo-local-db"),
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
    bb.log.info(`${machine.name}/${agentId}: ${recordCount} records from Kilo Code's local session database (${status})`);
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

type HostCommandOptions = { title: string; timeoutMs: number; pollMs?: number; home?: string };

function heldHostCommand(command: string) {
  return `( ${command} ); bb_usage_status=$?; printf '\\n%s:%s\\n' '__BB_HOST_COMMAND_DONE__' "$bb_usage_status"; while :; do sleep 3600; done`;
}

// createTerminalRequestSchema caps start.command at 10,000 characters, a
// boundary the serialized JSONL collectors have already crossed for some
// inputs. Oversized commands are staged on the host through files.write
// (whose content is unbounded) and run via `sh`, so the held wrapper -- DONE
// marker, exit code, error passthrough -- is identical either way. The
// content-addressed name keeps parallel agent syncs from racing on one path
// and never executes a stale script.
const HOST_COMMAND_MAX_CHARS = 10_000;

async function stageHostCommand(
  bb: BbPluginApi,
  machine: Machine,
  command: string,
  home: string | undefined,
  signal: AbortSignal,
) {
  const resolvedHome = home
    ?? (await bb.sdk.hosts.directory({ hostId: machine.id, signal })).directory;
  const sha256 = createHash("sha256").update(command).digest("hex");
  const path = `${resolvedHome}/.cache/bb-plugin-usage/host-command-${sha256}.sh`;
  const result = await bb.sdk.files.write({
    hostId: machine.id,
    path,
    content: command,
    contentEncoding: "utf8",
    createParents: true,
    expectedSha256: null,
    mode: 0o600,
  });
  const stagedSha256 = result.outcome === "written" ? result.sha256 : result.currentSha256;
  if (stagedSha256 !== sha256) throw new Error("the staged command file did not verify");
  return `sh ${shellQuote(path)}`;
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
  let startCommand = heldHostCommand(command);
  if (startCommand.length > HOST_COMMAND_MAX_CHARS) {
    // An oversized command can never be submitted, so a staging failure is
    // the real error; sending the inline command anyway would only reproduce
    // the contract's 10,000-character rejection.
    const staged = await stageHostCommand(bb, machine, command, options.home, signal)
      .catch((error) => {
        throw new Error(`${options.title} could not stage its command on ${machine.name}: ${errorMessage(error)}`);
      });
    startCommand = heldHostCommand(staged);
  }
  signal.throwIfAborted();
  const terminal = await bb.sdk.terminals.create({
    scope: { kind: "host_path", hostId: machine.id, cwd: null },
    cols: 120,
    rows: 24,
    title: options.title,
    start: { mode: "command", command: startCommand },
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

// OpenCode usage is collected on the enrolled HOST, so the
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
GROUP BY day, modelProviderId, model, (COALESCE(json_extract(m.data, '$.cost'), 0) > 0)
ORDER BY day, modelProviderId, model;`.trim();
}

// OpenCode v2 writes assistant steps to session_message instead of message and
// does not offer `opencode db`. Query its local database read-only on the host;
// never transfer message content, only daily token/cost aggregates.
export function openCodeV2Sql(): string {
  return openCodeSql()
    .replace("FROM session\n", "FROM session_v2\n")
    .replace("JOIN message m ON m.session_id = rs.id", "JOIN session_message m ON m.session_id = rs.id")
    .replace("json_extract(m.data, '$.providerID')", "json_extract(m.data, '$.model.providerID')")
    .replace("json_extract(m.data, '$.modelID')", "json_extract(m.data, '$.model.id')")
    .replace("json_extract(m.data, '$.role') = 'assistant'", "m.type = 'assistant' AND json_type(m.data, '$.tokens') IS NOT NULL");
}

export function openCodeCommand() {
  const sql = openCodeSql();
  const v2Sql = openCodeV2Sql();
  const database = `\${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db`;
  const v2Query = [
    "import json, sqlite3, sys",
    "db = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)",
    `rows = db.execute(${JSON.stringify(v2Sql)}).fetchall()`,
    "print(json.dumps([dict(zip(('day', 'modelProviderId', 'model', 'loggedCostUsd', 'inputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens'), row)) for row in rows]))",
  ].join("\n");
  const v2Probe = "import sqlite3,sys; db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); sys.exit(0 if db.execute(\"select count(*) from sqlite_master where type='table' and name in ('session_message','session_v2')\").fetchone()[0] == 2 else 1)";
  return [
    `if command -v python3 >/dev/null 2>&1 && [ -f "${database}" ] && python3 -c ${shellQuote(v2Probe)} "${database}" >/dev/null 2>&1; then result=$(python3 -c ${shellQuote(v2Query)} "${database}" 2>&1); bb_usage_query_status=$?; else if ! command -v opencode >/dev/null 2>&1; then printf '%s\\n' '__BB_USAGE_ERROR__:OpenCode CLI is required to collect OpenCode usage.'; exit 127; fi; result=$(opencode db ${shellQuote(sql)} --format json 2>&1); bb_usage_query_status=$?; fi`,
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

export function goLimitsHasFingerprintColumn(db: Database): boolean {
  try {
    const columns = db.prepare("PRAGMA table_info(opencode_go_limits)").all() as Array<{ name: string }>;
    return columns.some((column) => column.name === "account_fingerprint");
  } catch {
    return false;
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
    const fingerprint = extractOpenCodeGoFingerprint(output);

    db.transaction(() => {
      if (goLimitsHasFingerprintColumn(db)) {
        db.prepare(`INSERT INTO opencode_go_limits (machine_id, machine_name, plan_label, windows_json, fetched_at, account_fingerprint)
          VALUES (?, ?, 'Go', ?, ?, ?) ON CONFLICT(machine_id) DO UPDATE SET
          machine_name=excluded.machine_name, windows_json=excluded.windows_json, fetched_at=excluded.fetched_at,
          account_fingerprint=excluded.account_fingerprint`)
          .run(machine.id, machine.name, JSON.stringify(windows), attemptedAt, fingerprint);
      } else {
        db.prepare(`INSERT INTO opencode_go_limits (machine_id, machine_name, plan_label, windows_json, fetched_at)
          VALUES (?, ?, 'Go', ?, ?) ON CONFLICT(machine_id) DO UPDATE SET
          machine_name=excluded.machine_name, windows_json=excluded.windows_json, fetched_at=excluded.fetched_at`)
          .run(machine.id, machine.name, JSON.stringify(windows), attemptedAt);
      }
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
): ProviderLimitSource[] {
  const hasFingerprint = goLimitsHasFingerprintColumn(db);
  const rows = db.prepare(`SELECT
      state.machine_id machineId, state.machine_name machineName, state.status, state.error,
      limits.plan_label planLabel, limits.windows_json windowsJson, limits.fetched_at fetchedAt
      ${hasFingerprint ? ", limits.account_fingerprint accountFingerprint" : ""}
    FROM opencode_go_limit_state state
    LEFT JOIN opencode_go_limits limits ON limits.machine_id=state.machine_id
    ORDER BY state.machine_name`).all() as Array<{
    machineId: string; machineName: string; status: "ok" | "error"; error: string | null;
    planLabel: string | null; windowsJson: string | null; fetchedAt: string | null;
    accountFingerprint?: string | null;
  }>;

  return rows.flatMap((row): ProviderLimitSource[] => {
    if (!connectedMachineIds.has(row.machineId)) return [];
    const source = {
      machineId: row.machineId,
      machineName: row.machineName,
      agentId: "opencode-go",
      agentName: "OpenCode Go",
      providerId: "opencode-go",
      providerName: "OpenCode Go",
      accountEmail: null as string | null,
      accountIdentity: typeof row.accountFingerprint === "string" && row.accountFingerprint ? row.accountFingerprint : null,
      planLabel: row.planLabel ?? "Go",
    };
    try {
      const windows = row.windowsJson
        ? providerLimitWindowSchema.array().parse(JSON.parse(row.windowsJson))
        : [];
      if (row.status === "ok" && windows.length === 0) {
        throw new Error("OpenCode Go has no stored limit windows.");
      }
      return [{ ...source, windows, status: row.status, error: row.error, lastUpdatedAt: row.fetchedAt }];
    } catch {
      return [{
        ...source,
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
    SUM(CASE WHEN pricing_status='unknown' THEN processed_tokens ELSE 0 END) unknownPricedTokens,
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
    codexHomes: {
      type: "string",
      label: "Extra Codex homes",
      description: "Optional semicolon-separated Codex home directories. Scans sessions and archived_sessions in each. The default ~/.codex and ~/.codex-profiles/* homes are always scanned.",
      default: "",
    },
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
    extraUsageRoots: {
      type: "string",
      label: "Extra usage log roots",
      description: 'JSON object of agent IDs to arrays of absolute or ~/ log paths, e.g. {"codebuddy":["~/custom-buddy/projects"],"cursor":["~/custom-cursor/usage.jsonl"]}. Defaults are always scanned; paths resolve on each enrolled machine.',
      default: "{}",
    },
    codexProfileHomes: {
      type: "string",
      label: "Extra Codex profile homes",
      description: "Optional semicolon-separated CODEX_HOME directories for extra Codex accounts, as name=path or bare paths (the basename becomes the account label). ~/.codex, ~/.codex-profiles/*, and ~/.codex-* are always scanned.",
      default: "",
    },
  });
  const db = bb.storage.database();
  bb.storage.migrate(db, [migration, pricingMigration, syncMetadataMigration, multiAgentMigration, pricingCatalogMigration, projectMigration, openCodeGoLimitsMigration, openCodeGoFingerprintMigration, grokLimitsMigration, codexAttributionMigration]);
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
          syncAmp(bb, db, machine, home, timeoutSignal(AMP_SYNC_TIMEOUT_MS, serviceSignal)),
          syncJsonAgent(bb, db, machine, home, "codex", collectorSettings, timeoutSignal(JSON_AGENT_SYNC_TIMEOUT_MS, serviceSignal)),
          syncJsonAgent(bb, db, machine, home, "claude", collectorSettings, timeoutSignal(JSON_AGENT_SYNC_TIMEOUT_MS, serviceSignal)),
          syncJsonAgent(bb, db, machine, home, "copilot", collectorSettings, timeoutSignal(JSON_AGENT_SYNC_TIMEOUT_MS, serviceSignal)),
          syncJsonAgent(bb, db, machine, home, "codebuddy", collectorSettings, timeoutSignal(JSON_AGENT_SYNC_TIMEOUT_MS, serviceSignal)),
          syncJsonAgent(bb, db, machine, home, "cursor", collectorSettings, timeoutSignal(JSON_AGENT_SYNC_TIMEOUT_MS, serviceSignal)),
          syncJsonAgent(bb, db, machine, home, "dsh", collectorSettings, timeoutSignal(JSON_AGENT_SYNC_TIMEOUT_MS, serviceSignal)),
          syncJsonAgent(bb, db, machine, home, "freebuff", collectorSettings, timeoutSignal(JSON_AGENT_SYNC_TIMEOUT_MS, serviceSignal)),
          syncJsonAgent(bb, db, machine, home, "fx", collectorSettings, timeoutSignal(JSON_AGENT_SYNC_TIMEOUT_MS, serviceSignal)),
          syncJsonAgent(bb, db, machine, home, "grok", collectorSettings, timeoutSignal(JSON_AGENT_SYNC_TIMEOUT_MS, serviceSignal)),
          syncJsonAgent(bb, db, machine, home, "pi", collectorSettings, timeoutSignal(JSON_AGENT_SYNC_TIMEOUT_MS, serviceSignal)),
          syncJsonAgent(bb, db, machine, home, "prime", collectorSettings, timeoutSignal(JSON_AGENT_SYNC_TIMEOUT_MS, serviceSignal)),
          syncJsonAgent(bb, db, machine, home, "antigravity", collectorSettings, timeoutSignal(JSON_AGENT_SYNC_TIMEOUT_MS, serviceSignal)),
          syncJsonAgent(bb, db, machine, home, "thaura", collectorSettings, timeoutSignal(JSON_AGENT_SYNC_TIMEOUT_MS, serviceSignal)),
          syncDevin(bb, db, machine, home, timeoutSignal(DEVIN_SYNC_TIMEOUT_MS, serviceSignal)),
          syncKilocode(bb, db, machine, home, timeoutSignal(KILOCODE_SYNC_TIMEOUT_MS, serviceSignal)),
          syncOpenCode(bb, db, machine, timeoutSignal(OPENCODE_SYNC_TIMEOUT_MS, serviceSignal)),
          syncGrokLimits(bb, db, machine, timeoutSignal(60_000, serviceSignal)),
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

  const loadMachines = async (): Promise<Array<Machine & { status: string }>> => {
    try {
      return (await bb.sdk.hosts.list({ signal: AbortSignal.timeout(DASHBOARD_HOSTS_TIMEOUT_MS) }))
        .map((host) => ({ id: host.id, name: host.name, status: host.status }));
    } catch (error) {
      bb.log.warn(`Machine list unavailable: ${errorMessage(error)}`);
      return db.prepare(`SELECT machine_id id, MAX(machine_name) name, 'unavailable' status
        FROM usage_sources GROUP BY machine_id ORDER BY name`)
        .all() as Array<Machine & { status: string }>;
    }
  };

  const loadAccountPoolLimits = createAccountPoolLimitsLoader(bb);
  let providerLimitsRequest: Promise<z.infer<typeof rpcContract.providerLimits.output>> | null = null;
  const readProviderLimits = async () => {
    if (providerLimitsRequest) return providerLimitsRequest;
    providerLimitsRequest = (async () => {
      const [local, pool] = await Promise.all([
        (async () => {
          const machines = await loadMachines();
          const connectedMachineIds = new Set(
            machines.filter((machine) => machine.status === "connected").map((machine) => machine.id),
          );
          return groupProviderLimits([
            ...await loadProviderLimits(bb, machines, db),
            ...loadStoredOpenCodeGoLimits(db, connectedMachineIds),
            ...loadStoredGrokLimits(db, connectedMachineIds),
          ]);
        })(),
        loadAccountPoolLimits(),
      ]);
      return { limits: mergeAccountPoolLimits(local, pool.limits), accountPoolError: pool.error };
    })();
    try {
      return await providerLimitsRequest;
    } finally {
      providerLimitsRequest = null;
    }
  };

  bb.rpc.register(rpcContract, {
    async dashboard() {
      const machines = await loadMachines();
      const machineNames = new Map(machines.map((machine) => [machine.id, machine.name]));
      const rows = db.prepare(dashboardRecordsSql()).all() as Array<Omit<DashboardRecord, "machineName">>;
      const records = rows.map((row) => ({ ...row, machineName: machineNames.get(row.machineId) ?? "Unknown machine" }));
      const sources = db.prepare(`SELECT machine_id machineId, provider_id agentId, status, last_attempt_at lastAttemptAt,
        last_success_at lastSuccessAt, record_count recordCount, error FROM usage_sync_state ORDER BY machine_id, provider_id`).all() as SourceState[];
      const sync = syncCoordinator.snapshot();
      const modelProviders = db.prepare(`SELECT model_provider_id id, MAX(model_provider_name) name
        FROM usage_events GROUP BY model_provider_id ORDER BY name`).all() as Array<{ id: string; name: string }>;
      // Agents not in the static list (e.g. per-account Codex profiles) still
      // need a filter entry or the dashboard would hide their records.
      const knownAgentIds = new Set<string>(AGENTS.map((agent) => agent.id));
      const extraAgents = (db.prepare(`SELECT provider_id id, MAX(provider_name) name
        FROM usage_events GROUP BY provider_id ORDER BY name`).all() as Array<{ id: string; name: string }>)
        .filter((agent) => !knownAgentIds.has(agent.id));
      return {
        mode: "live" as const,
        generatedAt: new Date().toISOString(),
        lastSyncedAt: sync.completedAt,
        pricingVersion: pricingVersion(),
        machines,
        agents: [...AGENTS, ...extraAgents],
        modelProviders,
        records,
        sources,
        sync,
        notice: "Prompts and message content are never stored.",
      };
    },
    providerLimits: readProviderLimits,
    sync() {
      void syncAll().catch((error) => bb.log.error(`Usage sync failed: ${errorMessage(error)}`));
      return { ok: true as const };
    },
  });

  bb.background.service("usage-collector", {
    async start(signal) {
      while (!signal.aborted) {
        // Refresh before collecting so newly listed models price on the first sync.
        try { await refreshCatalog(db); } catch (error) {
          bb.log.warn(`models.dev catalog refresh failed: ${errorMessage(error)}`);
        }
        try { await syncAll(signal); } catch (error) {
          if (!signal.aborted) bb.log.error(`Usage sync failed: ${errorMessage(error)}`);
        }
        if (signal.aborted) break;
        await abortableDelay(15 * 60_000, signal);
      }
    },
  });
}
