import { Buffer } from "node:buffer";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";

export type AmpUsageAggregate = {
  threadId: string;
  day: string;
  modelProviderId: "amp";
  model: string;
  project: string;
  loggedCostUsd: null;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
};

export type AmpUsageScanInput = {
  cachePath: string;
  sinceDay: string;
};

export type AmpUsageScanResult = {
  agentId: "amp";
  threadCount: number;
  changedThreadCount: number;
  reusedThreadCount: number;
  failureCount: number;
  error: string | null;
  threads: Array<{ threadId: string; updated: string; rows: AmpUsageAggregate[] }>;
};

type CollectorDependencies = {
  buffer: typeof Buffer;
  childProcess: typeof import("node:child_process");
  fs: typeof import("node:fs");
  path: typeof import("node:path");
  zlib: typeof import("node:zlib");
};

const SCAN_BEGIN = "__BB_AMP_USAGE_SCAN_BEGIN__";
const SCAN_END = "__BB_AMP_USAGE_SCAN_END__";
const aggregateSchema = z.object({
  threadId: z.string().regex(/^T-[A-Za-z0-9-]+$/),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  modelProviderId: z.literal("amp"),
  model: z.string().min(1),
  project: z.string().min(1),
  loggedCostUsd: z.null(),
  uncachedInputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
const scanResultSchema = z.object({
  agentId: z.literal("amp"),
  threadCount: z.number().int().nonnegative(),
  changedThreadCount: z.number().int().nonnegative(),
  reusedThreadCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  error: z.string().nullable(),
  threads: z.array(z.object({
    threadId: z.string().regex(/^T-[A-Za-z0-9-]+$/),
    updated: z.string(),
    rows: z.array(aggregateSchema),
  })),
});

// Serialized and executed on an enrolled host. Full Amp thread exports remain
// inside this process; only normalized token metadata is emitted or cached.
async function ampUsageCollector(encodedInput: string, dependencies: CollectorDependencies) {
  const { buffer, childProcess, fs, path, zlib } = dependencies;
  const scanBegin = "__BB_AMP_USAGE_SCAN_BEGIN__";
  const scanEnd = "__BB_AMP_USAGE_SCAN_END__";
  const input = JSON.parse(buffer.from(encodedInput, "base64").toString("utf8")) as AmpUsageScanInput;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.sinceDay)) throw new Error("Invalid Amp usage history boundary.");

  type ThreadResult = { threadId: string; updated: string; rows: AmpUsageAggregate[] };
  type Cache = { version: number; threads: Record<string, ThreadResult> };
  const failures: string[] = [];
  const cacheVersion = 1;
  let cache: Cache = { version: cacheVersion, threads: {} };
  try {
    const parsed = JSON.parse(await fs.promises.readFile(input.cachePath, "utf8")) as Cache;
    if (parsed?.version === cacheVersion && parsed.threads && typeof parsed.threads === "object") cache = parsed;
  } catch { /* a missing or invalid cache is rebuilt */ }

  function command(args: string[]) {
    return childProcess.execFileSync("amp", args, {
      encoding: "utf8",
      maxBuffer: 100 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  function object(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  }

  function count(value: unknown) {
    const numeric = typeof value === "number" ? value : NaN;
    return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric) : 0;
  }

  function localDay(value: unknown) {
    if (typeof value !== "string") return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function projectName(value: unknown) {
    if (typeof value !== "string" || !value.trim()) return "Unknown";
    let decoded = value;
    try { decoded = decodeURIComponent(value.replace(/^file:\/\//, "")); } catch { /* retain undecoded input */ }
    const normalized = decoded.replace(/\\/g, "/").replace(/\/+$/, "");
    const segment = normalized.slice(normalized.lastIndexOf("/") + 1).trim();
    return segment ? segment.slice(0, 80) : "Unknown";
  }

  const listed: Array<{ id: string; updated: string }> = [];
  for (let offset = 0; ; offset += 100) {
    const page = JSON.parse(command(["threads", "list", "--include-archived", "--json", "--limit", "100", "--offset", String(offset)])) as unknown;
    if (!Array.isArray(page)) throw new Error("Amp thread listing returned an unexpected result shape.");
    for (const raw of page) {
      const entry = object(raw);
      if (typeof entry?.id === "string" && /^T-[A-Za-z0-9-]+$/.test(entry.id)
        && typeof entry.updated === "string" && entry.updated.slice(0, 10) >= input.sinceDay) {
        listed.push({ id: entry.id, updated: entry.updated });
      }
    }
    if (page.length < 100) break;
  }

  const nextThreads: Record<string, ThreadResult> = {};
  let changedThreadCount = 0;
  let reusedThreadCount = 0;
  for (const listedThread of listed) {
    const prior = cache.threads[listedThread.id];
    if (prior?.updated === listedThread.updated && Array.isArray(prior.rows)) {
      nextThreads[listedThread.id] = prior;
      reusedThreadCount += 1;
      continue;
    }
    try {
      const exported = object(JSON.parse(command(["threads", "export", listedThread.id])));
      if (!exported || exported.id !== listedThread.id || !Array.isArray(exported.messages)) {
        throw new Error("unexpected export shape");
      }
      const initial = object(object(exported.env)?.initial);
      const project = projectName(initial?.workingDirectory);
      const aggregates = new Map<string, AmpUsageAggregate>();
      for (const rawMessage of exported.messages) {
        const message = object(rawMessage);
        const usage = object(message?.usage);
        const day = localDay(usage?.timestamp);
        const model = typeof usage?.model === "string" && usage.model.trim() ? usage.model.trim().slice(0, 160) : "";
        if (!usage || !day || day < input.sinceDay || !model) continue;
        const uncached = count(usage.inputTokens);
        const cached = count(usage.cacheReadInputTokens);
        const writes = count(usage.cacheCreationInputTokens);
        const output = count(usage.outputTokens);
        if (uncached + cached + writes + output === 0) continue;
        const key = `${day}\0${model}\0${project}`;
        const priorRow = aggregates.get(key);
        if (priorRow) {
          priorRow.uncachedInputTokens += uncached;
          priorRow.cachedInputTokens += cached;
          priorRow.cacheWriteTokens += writes;
          priorRow.outputTokens += output;
        } else {
          aggregates.set(key, {
            threadId: listedThread.id,
            day,
            modelProviderId: "amp",
            model,
            project,
            loggedCostUsd: null,
            uncachedInputTokens: uncached,
            cachedInputTokens: cached,
            cacheWriteTokens: writes,
            outputTokens: output,
          });
        }
      }
      nextThreads[listedThread.id] = {
        threadId: listedThread.id,
        updated: listedThread.updated,
        rows: [...aggregates.values()].sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model)),
      };
      changedThreadCount += 1;
    } catch {
      failures.push("An Amp thread export could not be read.");
      if (prior) nextThreads[listedThread.id] = prior;
    }
  }

  try {
    await fs.promises.mkdir(path.dirname(input.cachePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${input.cachePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(temporaryPath, JSON.stringify({ version: cacheVersion, threads: nextThreads }), { encoding: "utf8", mode: 0o600 });
    await fs.promises.rename(temporaryPath, input.cachePath);
  } catch {
    failures.push("The metadata-only Amp usage cache could not be updated.");
  }

  const result: AmpUsageScanResult = {
    agentId: "amp",
    threadCount: listed.length,
    changedThreadCount,
    reusedThreadCount,
    failureCount: failures.length,
    error: failures[0] ?? null,
    threads: Object.values(nextThreads),
  };
  const encoded = zlib.gzipSync(JSON.stringify(result)).toString("base64");
  process.stdout.write(`${scanBegin}\n${encoded}\n${scanEnd}\n`);
}

export function ampUsageCollectorScript(input: AmpUsageScanInput) {
  const encodedInput = Buffer.from(JSON.stringify(input)).toString("base64");
  const dependencies = "{buffer:require('node:buffer').Buffer,childProcess:require('node:child_process'),fs:require('node:fs'),path:require('node:path'),zlib:require('node:zlib')}";
  return `(${ampUsageCollector.toString()})(${JSON.stringify(encodedInput)},${dependencies}).catch((error)=>{process.stderr.write('__BB_USAGE_ERROR__:'+String(error?.message??error).replace(/[\\r\\n]+/g,' ').slice(0,300)+'\\n');process.exitCode=1;});`;
}

export function compressedAmpUsageCollectorScript(input: AmpUsageScanInput) {
  const encodedScript = gzipSync(ampUsageCollectorScript(input)).toString("base64");
  return `eval(require('node:zlib').gunzipSync(Buffer.from(${JSON.stringify(encodedScript)},'base64')).toString('utf8'))`;
}

export function extractAmpUsageScan(output: string): AmpUsageScanResult {
  const normalized = output.replace(/\r/g, "");
  const start = normalized.lastIndexOf(`${SCAN_BEGIN}\n`);
  const end = normalized.lastIndexOf(`\n${SCAN_END}`);
  if (start < 0 || end < 0 || end <= start) throw new Error("Amp usage scan returned incomplete output.");
  const encoded = normalized.slice(start + SCAN_BEGIN.length + 1, end).trim();
  let value: unknown;
  try {
    value = JSON.parse(gunzipSync(Buffer.from(encoded, "base64")).toString("utf8"));
  } catch {
    throw new Error("Amp usage scan returned malformed output.");
  }
  const parsed = scanResultSchema.safeParse(value);
  if (!parsed.success) throw new Error("Amp usage scan returned an unexpected result shape.");
  return parsed.data;
}
