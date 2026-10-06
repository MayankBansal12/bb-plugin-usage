import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";
import type { HostUsageAggregate } from "../collectors";
import { kilocodeSqliteCollectorSource } from "./host-scripts.generated";

// Kilo Code's own session database is the single canonical usage source for
// the `kilocode` agent: the CLI writes it directly (XDG_DATA_HOME/kilo/kilo.db
// or ~/.local/share/kilo/kilo.db) and it works with or without BB. `kilocode`
// is deliberately NOT a JSONL agent — a second ~/.kilocode/usage.jsonl root
// would count the same turns twice, so that path is never scanned here.
//
// Within the database each model request is persisted by the engine that ran
// it, with that step's own cost and tokens (`input` already excludes cache
// reads/writes and `output` excludes `reasoning`):
// - the v1 processor writes a `step-finish` row to `part`;
// - the v2 runner writes one `assistant` row per step to `session_message`
//   (its cost is always 0, so those steps are estimated).
// Neither engine writes the other's table. The `session.cost`/`tokens_*`
// counters and v1 assistant `message` totals (which also absorb subagent
// costs) are derived from `step-finish` parts, so they are never read.
// Session.fork creates a new session (and new task child sessions) at fork
// time and re-inserts the copied history under it with cost zeroed; copied
// messages keep their original creation time, which therefore predates their
// session, whereas every request Kilo runs is recorded after its session was
// created. Those copies are skipped so forked history is counted once, in its
// source session. Only scalar fields are extracted in SQL; message content
// never leaves SQLite.
export type KilocodeScanInput = {
  agentId: "kilocode";
  dbPaths: string[];
  sinceDay: string;
};

async function kilocodeSqliteCollector(encodedInput: string, dependencies: {
  buffer: typeof Buffer;
  fs: typeof import("node:fs");
  path: typeof import("node:path");
  zlib: typeof import("node:zlib");
  loadSqlite: () => typeof import("node:sqlite");
}) {
  const { buffer, fs, path, zlib, loadSqlite } = dependencies;
  const scanBegin = "__BB_USAGE_SCAN_BEGIN__";
  const scanEnd = "__BB_USAGE_SCAN_END__";
  const input = JSON.parse(buffer.from(encodedInput, "base64").toString("utf8")) as KilocodeScanInput;
  if (input.agentId !== "kilocode") throw new Error("Unsupported usage agent.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.sinceDay)) throw new Error("Invalid usage history boundary.");

  const result = {
    agentId: "kilocode" as const,
    fileCount: 0,
    changedFileCount: 0,
    reusedFileCount: 0,
    failureCount: 0,
    error: null as string | null,
    rows: [] as HostUsageAggregate[],
  };
  const emit = () => {
    const encoded = zlib.gzipSync(JSON.stringify(result)).toString("base64");
    process.stdout.write(`${scanBegin}\n${encoded}\n${scanEnd}\n`);
  };

  function count(value: unknown) {
    const numeric = typeof value === "number" && Number.isFinite(value)
      ? value
      : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null;
    return Math.max(0, Math.round(numeric ?? 0));
  }

  function finite(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null;
  }

  function text(value: unknown, fallback: string) {
    return typeof value === "string" && value.trim() ? value : fallback;
  }

  function projectName(value: unknown) {
    if (typeof value !== "string" || !value.trim()) return "Unknown";
    const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
    const segment = normalized.slice(normalized.lastIndexOf("/") + 1);
    return segment.trim() ? segment.trim().slice(0, 80) : "Unknown";
  }

  // sinceDay is a calendar day on this host, so the cutoff is host-local
  // midnight rather than UTC midnight.
  const [sinceYear, sinceMonth, sinceDate] = input.sinceDay.split("-").map(Number);
  const cutoffMs = new Date(sinceYear!, sinceMonth! - 1, sinceDate!).getTime();

  function dayOf(value: unknown) {
    const ms = finite(value);
    if (ms === null || ms < cutoffMs) return null;
    const timestamp = new Date(ms);
    if (Number.isNaN(timestamp.getTime())) return null;
    const result = `${timestamp.getFullYear()}-${String(timestamp.getMonth() + 1).padStart(2, "0")}-${String(timestamp.getDate()).padStart(2, "0")}`;
    return result >= input.sinceDay ? result : null;
  }

  const candidates = [
    typeof process.env.XDG_DATA_HOME === "string" && process.env.XDG_DATA_HOME.trim()
      ? path.join(process.env.XDG_DATA_HOME.trim(), "kilo/kilo.db") : "",
    typeof process.env.APPDATA === "string" && process.env.APPDATA.trim()
      ? path.join(process.env.APPDATA.trim(), "kilo/kilo.db") : "",
    path.join(process.env.HOME || "~", ".local", "share", "kilo", "kilo.db"),
    ...input.dbPaths,
  ].filter(Boolean);
  const dbPath = candidates.find((candidate) => {
    try {
      fs.statSync(candidate);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      throw error;
    }
  });
  if (!dbPath) {
    emit();
    return;
  }

  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // `time.end` is when the step finished (absent on legacy parts, whose row
    // timestamp is the step's insertion time). Kilo records an auto-routed
    // step's actual model on the part; otherwise the assistant message names
    // the model that served it, regardless of later session model switches.
    const rows = db.prepare(`SELECT
        COALESCE(json_extract(p.data, '$.time.end'), p.time_created) AS at,
        COALESCE(json_extract(p.data, '$.model.providerID'), json_extract(m.data, '$.providerID')) AS providerId,
        COALESCE(json_extract(p.data, '$.model.modelID'), json_extract(m.data, '$.modelID')) AS modelId,
        s.directory AS directory,
        json_extract(p.data, '$.cost') AS cost,
        json_extract(p.data, '$.tokens.input') AS input,
        json_extract(p.data, '$.tokens.output') AS output,
        json_extract(p.data, '$.tokens.reasoning') AS reasoning,
        json_extract(p.data, '$.tokens.cache.read') AS cacheRead,
        json_extract(p.data, '$.tokens.cache.write') AS cacheWrite
      FROM part p
      LEFT JOIN message m ON m.id = p.message_id AND json_valid(m.data)
      LEFT JOIN session s ON s.id = p.session_id
      WHERE json_valid(p.data) AND json_extract(p.data, '$.type') = 'step-finish'
        AND COALESCE(m.time_created < s.time_created, 0) = 0
        AND COALESCE(json_extract(p.data, '$.time.end'), p.time_created) >= ?`).all(cutoffMs) as Array<Record<string, unknown>>;
    const hasV2 = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_message'").get();
    if (hasV2) {
      rows.push(...db.prepare(`SELECT
          COALESCE(json_extract(sm.data, '$.time.completed'), sm.time_created) AS at,
          json_extract(sm.data, '$.model.providerID') AS providerId,
          json_extract(sm.data, '$.model.id') AS modelId,
          s.directory AS directory,
          json_extract(sm.data, '$.cost') AS cost,
          json_extract(sm.data, '$.tokens.input') AS input,
          json_extract(sm.data, '$.tokens.output') AS output,
          json_extract(sm.data, '$.tokens.reasoning') AS reasoning,
          json_extract(sm.data, '$.tokens.cache.read') AS cacheRead,
          json_extract(sm.data, '$.tokens.cache.write') AS cacheWrite
        FROM session_message sm
        LEFT JOIN session s ON s.id = sm.session_id
        WHERE sm.type = 'assistant' AND json_valid(sm.data) AND json_type(sm.data, '$.tokens') = 'object'
          AND COALESCE(json_extract(sm.data, '$.time.completed'), sm.time_created) >= ?`).all(cutoffMs) as Array<Record<string, unknown>>);
    }

    const aggregates = new Map<string, HostUsageAggregate>();
    for (const row of rows) {
      const day = dayOf(row.at);
      if (!day) continue;
      const uncached = count(row.input);
      const cached = count(row.cacheRead);
      const writes = count(row.cacheWrite);
      // Reasoning is billed at the output rate.
      const output = count(row.output) + count(row.reasoning);
      const cost = finite(row.cost);
      const loggedCost = cost !== null && cost > 0 ? cost : null;
      if (uncached + cached + writes + output === 0 && loggedCost === null) continue;
      const modelId = text(row.modelId, "kilocode-unknown").trim();
      const providerId = text(row.providerId, "kilo").trim();
      const project = projectName(row.directory);
      // Steps with a recorded cost and unpriced steps stay in separate buckets
      // so one priced step never suppresses estimates for the rest.
      const key = JSON.stringify([day, providerId, modelId, project, loggedCost === null ? "estimate" : "logged"]);
      const existing = aggregates.get(key);
      if (!existing) {
        aggregates.set(key, {
          day,
          modelProviderId: providerId,
          model: modelId,
          project,
          loggedCostUsd: loggedCost,
          uncachedInputTokens: uncached,
          cachedInputTokens: cached,
          cacheWriteTokens: writes,
          outputTokens: output,
        });
      } else {
        existing.uncachedInputTokens += uncached;
        existing.cachedInputTokens += cached;
        existing.cacheWriteTokens += writes;
        existing.outputTokens += output;
        if (loggedCost !== null) existing.loggedCostUsd = (existing.loggedCostUsd ?? 0) + loggedCost;
      }
    }

    result.rows = [...aggregates.values()].sort((a, b) => a.day.localeCompare(b.day)
      || a.modelProviderId.localeCompare(b.modelProviderId) || a.model.localeCompare(b.model)
      || a.project.localeCompare(b.project) || Number(a.loggedCostUsd !== null) - Number(b.loggedCostUsd !== null));
    result.fileCount = 1;
    result.changedFileCount = 1;
  } finally {
    db.close();
  }
  emit();
}

export function kilocodeCollectorScript(input: KilocodeScanInput) {
  const encodedInput = Buffer.from(JSON.stringify(input)).toString("base64");
  const dependencies = "{buffer:require('node:buffer').Buffer,fs:require('node:fs'),path:require('node:path'),zlib:require('node:zlib'),loadSqlite:function(){return require('node:sqlite');}}";
  return `(${kilocodeSqliteCollectorSource})(${JSON.stringify(encodedInput)},${dependencies}).catch((error)=>{process.stderr.write('__BB_USAGE_ERROR__:'+String(error?.message??error).replace(/[\\r\\n]+/g,' ').slice(0,300)+'\\n');process.exitCode=1;});`;
}

export function compressedKilocodeCollectorScript(input: KilocodeScanInput) {
  const encodedScript = gzipSync(kilocodeCollectorScript(input)).toString("base64");
  return `eval(require('node:zlib').gunzipSync(Buffer.from(${JSON.stringify(encodedScript)},'base64')).toString('utf8'))`;
}
