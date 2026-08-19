import { Buffer } from "node:buffer";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import type { AgentId, HostUsageAggregate } from "../collectors";

export type HostJsonAgentId = Exclude<AgentId, "opencode">;

export type HostJsonScanInput = {
  agentId: HostJsonAgentId;
  roots: string[];
  cachePath: string;
  sinceDay: string;
};

export type HostJsonScanResult = {
  agentId: HostJsonAgentId;
  fileCount: number;
  changedFileCount: number;
  reusedFileCount: number;
  failureCount: number;
  error: string | null;
  rows: HostUsageAggregate[];
};

type CollectorDependencies = {
  buffer: typeof Buffer;
  fs: typeof import("node:fs");
  path: typeof import("node:path");
  crypto: typeof import("node:crypto");
  readline: typeof import("node:readline");
  zlib: typeof import("node:zlib");
};

const SCAN_BEGIN = "__BB_USAGE_SCAN_BEGIN__";
const SCAN_END = "__BB_USAGE_SCAN_END__";
const aggregateSchema = z.object({
  day: z.string(),
  modelProviderId: z.string(),
  model: z.string(),
  loggedCostUsd: z.number().finite().nullable(),
  uncachedInputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
const scanResultSchema = z.object({
  agentId: z.enum(["codex", "claude", "grok", "pi", "prime"]),
  fileCount: z.number().int().nonnegative(),
  changedFileCount: z.number().int().nonnegative(),
  reusedFileCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  error: z.string().nullable(),
  rows: z.array(aggregateSchema),
});

// This function is serialized and executed by Node.js on the enrolled host. Keep
// every runtime dependency inside the function or pass it through `dependencies`.
async function hostJsonCollector(encodedInput: string, dependencies: CollectorDependencies) {
  const { buffer, fs, path, crypto, readline, zlib } = dependencies;
  const cacheVersion = 1;
  const scanBegin = "__BB_USAGE_SCAN_BEGIN__";
  const scanEnd = "__BB_USAGE_SCAN_END__";
  const input = JSON.parse(buffer.from(encodedInput, "base64").toString("utf8")) as HostJsonScanInput;
  const allowedAgents = new Set<HostJsonAgentId>(["codex", "claude", "grok", "pi", "prime"]);
  if (!allowedAgents.has(input.agentId)) throw new Error("Unsupported usage agent.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.sinceDay)) throw new Error("Invalid usage history boundary.");

  type CacheEntry = { signature: string; rows: HostUsageAggregate[] };
  type Cache = { version: number; agentId: HostJsonAgentId; files: Record<string, CacheEntry> };
  const failures: string[] = [];
  let discoveryFailed = false;
  const cutoffMs = Date.parse(`${input.sinceDay}T00:00:00Z`);

  function object(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  }

  function finite(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null;
  }

  function count(value: unknown) {
    return Math.max(0, Math.round(finite(value) ?? 0));
  }

  function text(value: unknown, fallback: string) {
    return typeof value === "string" && value.trim() ? value : fallback;
  }

  function day(value: unknown) {
    if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim()) return null;
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return null;
    const result = new Date(timestamp).toISOString().slice(0, 10);
    return result >= input.sinceDay ? result : null;
  }

  function validRow(value: unknown): value is HostUsageAggregate {
    const row = object(value);
    return Boolean(row
      && typeof row.day === "string"
      && typeof row.modelProviderId === "string"
      && typeof row.model === "string"
      && (row.loggedCostUsd === null || finite(row.loggedCostUsd) !== null)
      && finite(row.uncachedInputTokens) !== null
      && finite(row.cachedInputTokens) !== null
      && finite(row.cacheWriteTokens) !== null
      && finite(row.outputTokens) !== null);
  }

  function validCacheEntry(value: unknown): value is CacheEntry {
    const entry = object(value);
    return Boolean(entry && typeof entry.signature === "string"
      && Array.isArray(entry.rows) && entry.rows.every(validRow));
  }

  function add(target: Map<string, HostUsageAggregate>, raw: HostUsageAggregate) {
    if (raw.day < input.sinceDay) return;
    const row: HostUsageAggregate = {
      day: raw.day,
      modelProviderId: text(raw.modelProviderId, "unknown"),
      model: text(raw.model, "unknown"),
      loggedCostUsd: finite(raw.loggedCostUsd),
      uncachedInputTokens: count(raw.uncachedInputTokens),
      cachedInputTokens: count(raw.cachedInputTokens),
      cacheWriteTokens: count(raw.cacheWriteTokens),
      outputTokens: count(raw.outputTokens),
    };
    const key = JSON.stringify([row.day, row.modelProviderId, row.model]);
    const prior = target.get(key);
    if (!prior) {
      target.set(key, row);
      return;
    }
    prior.uncachedInputTokens += row.uncachedInputTokens;
    prior.cachedInputTokens += row.cachedInputTokens;
    prior.cacheWriteTokens += row.cacheWriteTokens;
    prior.outputTokens += row.outputTokens;
    if (row.loggedCostUsd !== null) prior.loggedCostUsd = (prior.loggedCostUsd ?? 0) + row.loggedCostUsd;
  }

  function matches(filePath: string) {
    const name = path.basename(filePath);
    if (input.agentId === "codex") return name.startsWith("rollout-") && name.endsWith(".jsonl");
    if (input.agentId === "grok") return name === "unified.jsonl";
    return name.endsWith(".jsonl");
  }

  async function walk(directory: string, files: string[]) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        discoveryFailed = true;
        failures.push("A usage directory could not be read.");
      }
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(entryPath, files);
      else if (entry.isFile() && matches(entryPath)) files.push(entryPath);
    }
  }

  async function parseFile(filePath: string) {
    const rows = new Map<string, HostUsageAggregate>();
    let codexModel = "codex-unknown";
    const stream = fs.createReadStream(filePath, { encoding: "utf8", highWaterMark: 1024 * 1024 });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let raw: unknown;
      try { raw = JSON.parse(line); } catch { continue; }
      const value = object(raw);
      if (!value) continue;

      if (input.agentId === "codex") {
        const payload = object(value.payload);
        if ((value.type === "turn_context" || value.type === "session_meta") && payload) {
          codexModel = text(payload.model, codexModel);
        }
        if (value.type !== "event_msg" || payload?.type !== "token_count") continue;
        const usage = object(object(payload.info)?.last_token_usage);
        const usageDay = day(value.timestamp);
        if (!usage || !usageDay) continue;
        const inputTokens = count(usage.input_tokens);
        const cached = Math.min(inputTokens, count(usage.cached_input_tokens));
        add(rows, {
          day: usageDay, modelProviderId: "openai", model: codexModel, loggedCostUsd: null,
          uncachedInputTokens: inputTokens - cached, cachedInputTokens: cached,
          cacheWriteTokens: count(usage.cache_write_input_tokens), outputTokens: count(usage.output_tokens),
        });
        continue;
      }

      if (input.agentId === "claude") {
        if (value.type !== "assistant") continue;
        const message = object(value.message);
        const usage = object(message?.usage);
        const usageDay = day(value.timestamp);
        if (!message || !usage || !usageDay) continue;
        const model = text(message.model, "claude-unknown");
        const uncached = count(usage.input_tokens);
        const cached = count(usage.cache_read_input_tokens);
        const writes = count(usage.cache_creation_input_tokens);
        const output = count(usage.output_tokens);
        if (model === "<synthetic>" && uncached + cached + writes + output === 0) continue;
        add(rows, {
          day: usageDay, modelProviderId: "anthropic", model, loggedCostUsd: null,
          uncachedInputTokens: uncached, cachedInputTokens: cached, cacheWriteTokens: writes, outputTokens: output,
        });
        continue;
      }

      if (input.agentId === "grok") {
        if (value.msg !== "shell.turn.inference_done") continue;
        const usage = object(value.ctx);
        const usageDay = day(value.ts);
        if (!usage || usage.prompt_tokens === undefined || !usageDay) continue;
        const prompt = count(usage.prompt_tokens);
        const cached = Math.min(prompt, count(usage.cached_prompt_tokens));
        add(rows, {
          day: usageDay, modelProviderId: "xai", model: text(usage.model, "grok-build-0.1"), loggedCostUsd: null,
          uncachedInputTokens: prompt - cached, cachedInputTokens: cached, cacheWriteTokens: 0,
          outputTokens: count(usage.completion_tokens) + count(usage.reasoning_tokens),
        });
        continue;
      }

      if (input.agentId === "pi" || input.agentId === "prime") {
        if (value.type !== "message") continue;
        const message = object(value.message);
        const usage = object(message?.usage);
        const usageDay = day(value.timestamp ?? message?.timestamp);
        if (!message || message.role !== "assistant" || !usage || !usageDay) continue;
        add(rows, {
          day: usageDay,
          modelProviderId: text(message.provider, "unknown"),
          model: text(message.responseModel, text(message.model, "unknown")),
          loggedCostUsd: finite(object(usage.cost)?.total),
          uncachedInputTokens: count(usage.input), cachedInputTokens: count(usage.cacheRead),
          cacheWriteTokens: count(usage.cacheWrite), outputTokens: count(usage.output),
        });
      }
    }
    return [...rows.values()];
  }

  let cache: Cache = { version: cacheVersion, agentId: input.agentId, files: {} };
  try {
    const parsed = object(JSON.parse(await fs.promises.readFile(input.cachePath, "utf8")));
    const parsedFiles = object(parsed?.files);
    if (parsed?.version === cacheVersion && parsed.agentId === input.agentId && parsedFiles) {
      const files: Record<string, CacheEntry> = {};
      for (const [sourceId, entry] of Object.entries(parsedFiles)) {
        if (validCacheEntry(entry)) files[sourceId] = entry;
      }
      cache = { version: cacheVersion, agentId: input.agentId, files };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push("The prior metadata cache could not be read.");
  }

  const discovered: string[] = [];
  for (const root of [...new Set(input.roots)]) await walk(root, discovered);
  discovered.sort();
  const nextFiles: Record<string, CacheEntry> = {};
  const allRows = new Map<string, HostUsageAggregate>();
  let fileCount = 0;
  let changedFileCount = 0;
  let reusedFileCount = 0;

  for (const filePath of discovered) {
    const sourceId = crypto.createHash("sha256").update(filePath).digest("hex");
    const prior = cache.files[sourceId];
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.mtimeMs < cutoffMs) continue;
      fileCount += 1;
      const signature = `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
      if (prior?.signature === signature && Array.isArray(prior.rows) && prior.rows.every(validRow)) {
        nextFiles[sourceId] = prior;
        for (const row of prior.rows) add(allRows, row);
        reusedFileCount += 1;
        continue;
      }
      const rows = await parseFile(filePath);
      nextFiles[sourceId] = { signature, rows };
      for (const row of rows) add(allRows, row);
      changedFileCount += 1;
    } catch {
      failures.push("A usage log could not be read.");
      if (prior && Array.isArray(prior.rows) && prior.rows.every(validRow)) {
        nextFiles[sourceId] = prior;
        for (const row of prior.rows) add(allRows, row);
      }
    }
  }

  if (discoveryFailed) {
    for (const [sourceId, prior] of Object.entries(cache.files)) {
      if (nextFiles[sourceId] || !Array.isArray(prior.rows) || !prior.rows.every(validRow)) continue;
      nextFiles[sourceId] = prior;
      for (const row of prior.rows) add(allRows, row);
    }
  }

  try {
    await fs.promises.mkdir(path.dirname(input.cachePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${input.cachePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(temporaryPath, JSON.stringify({
      version: cacheVersion,
      agentId: input.agentId,
      files: nextFiles,
    }), { encoding: "utf8", mode: 0o600 });
    await fs.promises.rename(temporaryPath, input.cachePath);
  } catch {
    failures.push("The metadata-only usage cache could not be updated.");
  }

  const rows = [...allRows.values()].sort((a, b) => a.day.localeCompare(b.day)
    || a.modelProviderId.localeCompare(b.modelProviderId) || a.model.localeCompare(b.model));
  const result: HostJsonScanResult = {
    agentId: input.agentId,
    fileCount,
    changedFileCount,
    reusedFileCount,
    failureCount: failures.length,
    error: failures[0]?.replace(/[\r\n]+/g, " ").slice(0, 200) ?? null,
    rows,
  };
  const encoded = zlib.gzipSync(JSON.stringify(result)).toString("base64");
  process.stdout.write(`${scanBegin}\n${encoded}\n${scanEnd}\n`);
}

export function hostJsonCollectorScript(input: HostJsonScanInput) {
  const encodedInput = Buffer.from(JSON.stringify(input)).toString("base64");
  const dependencies = "{buffer:require('node:buffer').Buffer,fs:require('node:fs'),path:require('node:path'),crypto:require('node:crypto'),readline:require('node:readline'),zlib:require('node:zlib')}";
  return `(${hostJsonCollector.toString()})(${JSON.stringify(encodedInput)},${dependencies}).catch((error)=>{process.stderr.write('__BB_USAGE_ERROR__:'+String(error?.message??error).replace(/[\\r\\n]+/g,' ').slice(0,300)+'\\n');process.exitCode=1;});`;
}

export function compressedHostJsonCollectorScript(input: HostJsonScanInput) {
  const encodedScript = gzipSync(hostJsonCollectorScript(input)).toString("base64");
  return `eval(require('node:zlib').gunzipSync(Buffer.from(${JSON.stringify(encodedScript)},'base64')).toString('utf8'))`;
}

export function extractHostJsonScan(output: string): HostJsonScanResult {
  const normalized = output.replace(/\r/g, "");
  const start = normalized.lastIndexOf(`${SCAN_BEGIN}\n`);
  const end = normalized.lastIndexOf(`\n${SCAN_END}`);
  if (start < 0 || end < 0 || end <= start) throw new Error("Host usage scan returned incomplete output.");
  const encoded = normalized.slice(start + SCAN_BEGIN.length + 1, end).trim();
  let value: unknown;
  try {
    value = JSON.parse(gunzipSync(Buffer.from(encoded, "base64")).toString("utf8"));
  } catch {
    throw new Error("Host usage scan returned malformed output.");
  }
  const parsed = scanResultSchema.safeParse(value);
  if (!parsed.success) throw new Error("Host usage scan returned an unexpected result shape.");
  return parsed.data;
}
