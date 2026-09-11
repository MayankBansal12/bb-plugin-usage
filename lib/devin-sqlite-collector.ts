import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";
import type { HostUsageAggregate } from "../collectors";

export type DevinScanInput = {
  agentId: "devin";
  dbPaths: string[];
  sinceDay: string;
};

type CollectorDependencies = {
  buffer: typeof Buffer;
  fs: typeof import("node:fs");
  path: typeof import("node:path");
  zlib: typeof import("node:zlib");
  // node:sqlite is only resolvable on Node.js >= 22.13, so it is loaded lazily
  // inside the collector where require failures become a clean diagnostic.
  loadSqlite: () => typeof import("node:sqlite");
};

// This function is serialized and executed by Node.js on the enrolled host. Keep
// every runtime dependency inside the function or pass it through `dependencies`.
// The output reuses the host-json-collector wire format (gzipped scan JSON between
// __BB_USAGE_SCAN_BEGIN__/END markers) so the plugin server decodes it with
// extractHostJsonScan and prices it with parseHostUsageAggregates.
async function devinSqliteCollector(encodedInput: string, dependencies: CollectorDependencies) {
  const { buffer, fs, path, zlib, loadSqlite } = dependencies;
  const scanBegin = "__BB_USAGE_SCAN_BEGIN__";
  const scanEnd = "__BB_USAGE_SCAN_END__";
  const input = JSON.parse(buffer.from(encodedInput, "base64").toString("utf8")) as DevinScanInput;
  if (input.agentId !== "devin") throw new Error("Unsupported usage agent.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.sinceDay)) throw new Error("Invalid usage history boundary.");

  const result = {
    agentId: "devin" as const,
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

  function text(value: unknown, fallback: string) {
    return typeof value === "string" && value.trim() ? value : fallback;
  }

  // Only the working directory's final segment is recorded, so usage can be
  // grouped by project without storing the machine's directory layout.
  function projectName(value: unknown) {
    if (typeof value !== "string" || !value.trim()) return "Unknown";
    const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
    const segment = normalized.slice(normalized.lastIndexOf("/") + 1);
    return segment.trim() ? segment.trim().slice(0, 80) : "Unknown";
  }

  // Host-local calendar day, matching the JSONL collectors: the host owns the
  // data, so day buckets follow the host's timezone, not the server's.
  function dayOf(value: unknown) {
    if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim()) return null;
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return null;
    const parsed = new Date(timestamp);
    const result = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
    return result >= input.sinceDay ? result : null;
  }

  // Devin documents ~/.local/share/devin on every platform and honors
  // XDG_DATA_HOME; the macOS platform data dir (server-supplied) and Windows
  // APPDATA location are covered defensively in case some CLI build resolves
  // the OS-native directory instead.
  const candidates = [
    typeof process.env.XDG_DATA_HOME === "string" && process.env.XDG_DATA_HOME.trim()
      ? path.join(process.env.XDG_DATA_HOME.trim(), "devin/cli/sessions.db") : "",
    typeof process.env.APPDATA === "string" && process.env.APPDATA.trim()
      ? path.join(process.env.APPDATA.trim(), "devin/cli/sessions.db") : "",
    ...input.dbPaths,
  ].filter(Boolean);
  const dbPath = candidates.find((candidate) => {
    try {
      fs.statSync(candidate);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      // Access errors must fail the scan so sync preserves previously saved
      // usage instead of replacing it with a successful empty result.
      throw error;
    }
  });
  // Devin CLI never ran on this machine: a normal empty scan, not an error.
  if (!dbPath) {
    emit();
    return;
  }

  const { DatabaseSync } = loadSqlite();
  // Devin keeps the database open in WAL mode; open strictly read-only so the
  // scan can never block or corrupt the running CLI.
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const nodes = db.prepare(`SELECT
        n.session_id sessionId,
        n.row_id nodeId,
        n.created_at nodeCreatedAt,
        s.model model,
        s.working_directory workingDirectory,
        json_extract(n.chat_message, '$.metadata.request_id') requestId,
        json_extract(n.chat_message, '$.metadata.created_at') createdAt,
        json_extract(n.chat_message, '$.metadata.metrics.input_tokens') inputTokens,
        json_extract(n.chat_message, '$.metadata.metrics.output_tokens') outputTokens,
        json_extract(n.chat_message, '$.metadata.metrics.cache_read_tokens') cacheReadTokens,
        json_extract(n.chat_message, '$.metadata.metrics.cache_creation_tokens') cacheWriteTokens
      FROM message_nodes n LEFT JOIN sessions s ON s.id = n.session_id
      WHERE n.chat_message LIKE '%assistant%' AND n.chat_message LIKE '%input_tokens%'
        AND json_valid(n.chat_message)
        AND json_extract(n.chat_message, '$.role') = 'assistant'
        AND json_extract(n.chat_message, '$.metadata.metrics') IS NOT NULL`).all() as Array<Record<string, unknown>>;

    // The CLI writes several nodes per model request (thinking, content, tool
    // calls) carrying the same request_id and identical counters; merge by
    // request_id so each API response is counted once. message_nodes is a
    // forest: retry/edit branches copy earlier nodes (same request_id, still
    // deduplicated) and re-issue the request under a fresh request_id — real
    // additional billed usage, deliberately counted rather than restricted to
    // sessions.main_chain_id.
    const events = new Map<string, HostUsageAggregate>();
    for (const node of nodes) {
      const timestamp = node.createdAt
        ?? (typeof node.nodeCreatedAt === "number" ? node.nodeCreatedAt * 1000 : null);
      const usageDay = dayOf(timestamp);
      if (!usageDay) continue;
      const uncached = count(node.inputTokens);
      const cached = count(node.cacheReadTokens);
      const writes = count(node.cacheWriteTokens);
      const output = count(node.outputTokens);
      if (uncached + cached + writes + output === 0) continue;
      const eventKey = typeof node.requestId === "string" && node.requestId
        ? `request:${node.requestId}`
        : `node:${text(node.sessionId, "session")}:${count(node.nodeId)}`;
      const prior = events.get(eventKey);
      if (!prior) {
        events.set(eventKey, {
          day: usageDay,
          modelProviderId: "devin",
          model: text(node.model, "devin-unknown"),
          project: projectName(node.workingDirectory),
          loggedCostUsd: null,
          uncachedInputTokens: uncached,
          cachedInputTokens: cached,
          cacheWriteTokens: writes,
          outputTokens: output,
        });
        continue;
      }
      prior.uncachedInputTokens = Math.max(prior.uncachedInputTokens, uncached);
      prior.cachedInputTokens = Math.max(prior.cachedInputTokens, cached);
      prior.cacheWriteTokens = Math.max(prior.cacheWriteTokens, writes);
      prior.outputTokens = Math.max(prior.outputTokens, output);
    }

    const aggregates = new Map<string, HostUsageAggregate>();
    for (const event of events.values()) {
      const key = JSON.stringify([event.day, event.model, event.project]);
      const prior = aggregates.get(key);
      if (!prior) {
        aggregates.set(key, event);
        continue;
      }
      prior.uncachedInputTokens += event.uncachedInputTokens;
      prior.cachedInputTokens += event.cachedInputTokens;
      prior.cacheWriteTokens += event.cacheWriteTokens;
      prior.outputTokens += event.outputTokens;
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

export function devinCollectorScript(input: DevinScanInput) {
  const encodedInput = Buffer.from(JSON.stringify(input)).toString("base64");
  const dependencies = "{buffer:require('node:buffer').Buffer,fs:require('node:fs'),path:require('node:path'),zlib:require('node:zlib'),loadSqlite:function(){return require('node:sqlite');}}";
  return `(${devinSqliteCollector.toString()})(${JSON.stringify(encodedInput)},${dependencies}).catch((error)=>{process.stderr.write('__BB_USAGE_ERROR__:'+String(error?.message??error).replace(/[\\r\\n]+/g,' ').slice(0,300)+'\\n');process.exitCode=1;});`;
}

export function compressedDevinCollectorScript(input: DevinScanInput) {
  const encodedScript = gzipSync(devinCollectorScript(input)).toString("base64");
  return `eval(require('node:zlib').gunzipSync(Buffer.from(${JSON.stringify(encodedScript)},'base64')).toString('utf8'))`;
}
