import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";
import type { HostUsageAggregate } from "../collectors";
import { kilocodeSqliteCollectorSource } from "./host-scripts.generated";

// Kilo Code's own session database is the single canonical usage source for
// the `kilocode` agent: the CLI writes it directly (XDG_DATA_HOME/kilo/kilo.db
// or ~/.local/share/kilo/kilo.db), it holds session-scoped token and cost
// totals, and it works with or without BB. `kilocode` is deliberately NOT a
// JSONL agent — a second ~/.kilocode/usage.jsonl root would count the same
// turns twice, so that path is never scanned here.
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

  function dayOf(value: unknown) {
    if ((typeof value !== "number") || !Number.isFinite(value)) return null;
    const timestamp = new Date(value);
    if (Number.isNaN(timestamp.getTime())) return null;
    const result = `${timestamp.getFullYear()}-${String(timestamp.getMonth() + 1).padStart(2, "0")}-${String(timestamp.getDate()).padStart(2, "0")}`;
    return result >= input.sinceDay ? result : null;
  }

  function parseModelJson(raw: unknown): { modelId: string; providerId: string } {
    if (typeof raw !== "string" || !raw.trim()) return { modelId: "kilocode-unknown", providerId: "kilo" };
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const id = typeof parsed.id === "string" && parsed.id.trim() ? parsed.id.trim() : "kilocode-unknown";
        const provider = typeof parsed.providerID === "string" && parsed.providerID.trim() ? parsed.providerID.trim() : "kilo";
        return { modelId: id, providerId: provider };
      }
    } catch { /* ignore malformed JSON */ }
    return { modelId: "kilocode-unknown", providerId: "kilo" };
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
    const cutoffMs = Date.parse(`${input.sinceDay}T00:00:00Z`);
    const rows = db.prepare(`SELECT
        time_created,
        model,
        directory,
        cost,
        tokens_input,
        tokens_output,
        tokens_reasoning,
        tokens_cache_read,
        tokens_cache_write
      FROM session
      WHERE time_created >= ?`).all(cutoffMs) as Array<Record<string, unknown>>;

    const aggregates = new Map<string, HostUsageAggregate>();
    for (const row of rows) {
      const day = dayOf(row.time_created);
      if (!day) continue;
      const { modelId, providerId } = parseModelJson(row.model);
      const project = projectName(row.directory);
      const key = JSON.stringify([day, providerId, modelId, project]);
      const existing = aggregates.get(key);
      const uncached = count(row.tokens_input) - Math.min(count(row.tokens_input), count(row.tokens_cache_read));
      const cached = count(row.tokens_cache_read);
      const writes = count(row.tokens_cache_write);
      const output = count(row.tokens_output) + count(row.tokens_reasoning);
      const loggedCost = finite(row.cost);

      if (!existing) {
        aggregates.set(key, {
          day,
          modelProviderId: providerId,
          model: modelId,
          project,
          loggedCostUsd: loggedCost !== null && loggedCost > 0 ? loggedCost : null,
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
        if (loggedCost !== null && loggedCost > 0) {
          existing.loggedCostUsd = (existing.loggedCostUsd ?? 0) + loggedCost;
        }
      }
    }

    result.rows = [...aggregates.values()].sort((a, b) => a.day.localeCompare(b.day)
      || a.modelProviderId.localeCompare(b.modelProviderId) || a.model.localeCompare(b.model)
      || a.project.localeCompare(b.project));
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
