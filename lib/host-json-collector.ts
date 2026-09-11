import { Buffer } from "node:buffer";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import type { AgentId, HostUsageAggregate } from "../collectors";

// Agents collected by walking JSONL session logs. "devin" is excluded: its
// usage lives in a SQLite database handled by devin-sqlite-collector.ts.
export type HostJsonAgentId = Exclude<AgentId, "opencode" | "devin">;

// Agents whose host scan emits the shared aggregate-row wire format.
export type HostScanAgentId = Exclude<AgentId, "opencode">;

export type HostJsonScanInput = {
  agentId: HostJsonAgentId;
  roots: string[];
  cachePath: string;
  sinceDay: string;
  // Directory whose immediate subdirectories are per-account agent homes
  // (e.g. ~/.codex-profiles/<name> for extra Codex accounts). Each
  // <name>/sessions tree is scanned and its rows carry `account: <name>`.
  accountRoot?: string;
};

export type HostJsonScanResult = {
  agentId: HostScanAgentId;
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
  project: z.string().default("Unknown"),
  account: z.string().optional(),
  loggedCostUsd: z.number().finite().nullable(),
  uncachedInputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
const scanResultSchema = z.object({
  agentId: z.enum(["codex", "claude", "dsh", "devin", "fx", "grok", "pi", "prime", "antigravity", "thaura"]),
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
  // v2: retained hashed Claude response identities so repeated transcript rows
  // and copied/forked transcripts can be deduplicated before aggregation.
  // v3: added the per-session project label to every aggregate row.
  // v4: buckets days in the host's local timezone instead of UTC and drops
  // zero-token / zero-cost rows. Cached rows store a precomputed `day`, so the
  // version MUST rise or upgraded hosts keep serving UTC buckets forever,
  // silently mixed with newly parsed local ones.
  // v5: keep recorded and unpriced Pi/Prime usage in separate buckets.
  const cacheVersion = 5;
  const scanBegin = "__BB_USAGE_SCAN_BEGIN__";
  const scanEnd = "__BB_USAGE_SCAN_END__";
  const input = JSON.parse(buffer.from(encodedInput, "base64").toString("utf8")) as HostJsonScanInput;
  const allowedAgents = new Set<HostJsonAgentId>(["codex", "claude", "dsh", "fx", "grok", "pi", "prime", "antigravity", "thaura"]);
  if (!allowedAgents.has(input.agentId)) throw new Error("Unsupported usage agent.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.sinceDay)) throw new Error("Invalid usage history boundary.");
  // Extra per-account homes (e.g. Codex profiles). Only the codex parser knows
  // how to attribute them today, so other agents ignore the directory.
  const accountRoot = input.agentId === "codex" && typeof input.accountRoot === "string" && input.accountRoot.trim()
    ? input.accountRoot.replace(/\/+$/, "")
    : null;

  type CachedUsageRow = HostUsageAggregate & { eventKey?: string };
  type CacheEntry = { signature: string; rows: CachedUsageRow[] };
  type Cache = { version: number; agentId: HostJsonAgentId; files: Record<string, CacheEntry> };
  const failures: string[] = [];
  let discoveryFailed = false;
  const cutoffMs = Date.parse(`${input.sinceDay}T00:00:00Z`);
  const canDecompressZstd = typeof zlib.zstdDecompressSync === "function";
  // Files discovered under an account home map to that account name.
  const accountByPath = new Map<string, string>();

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

  // Only the working directory's final segment is recorded, so usage can be
  // grouped by project without storing the machine's directory layout.
  function projectName(value: unknown) {
    if (typeof value !== "string" || !value.trim()) return "Unknown";
    const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
    const segment = normalized.slice(normalized.lastIndexOf("/") + 1);
    return segment.trim() ? segment.trim().slice(0, 80) : "Unknown";
  }

  function day(value: unknown) {
    if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim()) return null;
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return null;
    const parsed = new Date(timestamp);
    const result = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
    return result >= input.sinceDay ? result : null;
  }

  function validRow(value: unknown): value is CachedUsageRow {
    const row = object(value);
    return Boolean(row
      && typeof row.day === "string"
      && typeof row.modelProviderId === "string"
      && typeof row.model === "string"
      && typeof row.project === "string"
      && (row.account === undefined || typeof row.account === "string")
      && (row.loggedCostUsd === null || finite(row.loggedCostUsd) !== null)
      && finite(row.uncachedInputTokens) !== null
      && finite(row.cachedInputTokens) !== null
      && finite(row.cacheWriteTokens) !== null
      && finite(row.outputTokens) !== null
      && (row.eventKey === undefined || typeof row.eventKey === "string"));
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
      project: text(raw.project, "Unknown"),
      loggedCostUsd: finite(raw.loggedCostUsd),
      uncachedInputTokens: count(raw.uncachedInputTokens),
      cachedInputTokens: count(raw.cachedInputTokens),
      cacheWriteTokens: count(raw.cacheWriteTokens),
      outputTokens: count(raw.outputTokens),
    };
    const account = text(raw.account, "");
    if (account) row.account = account;
    const keyed = new Set<HostJsonAgentId>(["pi", "prime", "thaura"]).has(input.agentId);
    const key = JSON.stringify([row.day, row.modelProviderId, row.model, row.project, row.account ?? null,
      keyed ? (row.loggedCostUsd !== null && row.loggedCostUsd > 0 ? "logged" : "estimate") : "all"]);
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

  function mergeEvent(target: Map<string, CachedUsageRow>, raw: CachedUsageRow) {
    if (!raw.eventKey) return;
    const prior = target.get(raw.eventKey);
    if (!prior) {
      target.set(raw.eventKey, raw);
      return;
    }
    // Claude currently repeats the same final counters on every content-block
    // row. Maxima also handle a partially-written/incremental row safely
    // without multiplying one API response's usage.
    prior.uncachedInputTokens = Math.max(prior.uncachedInputTokens, raw.uncachedInputTokens);
    prior.cachedInputTokens = Math.max(prior.cachedInputTokens, raw.cachedInputTokens);
    prior.cacheWriteTokens = Math.max(prior.cacheWriteTokens, raw.cacheWriteTokens);
    prior.outputTokens = Math.max(prior.outputTokens, raw.outputTokens);
    if (raw.loggedCostUsd !== null) prior.loggedCostUsd = Math.max(prior.loggedCostUsd ?? 0, raw.loggedCostUsd);
  }

  function matches(filePath: string) {
    const name = path.basename(filePath);
    if (input.agentId === "codex") return name.startsWith("rollout-") && name.endsWith(".jsonl");
    // Only the canonical current generation: dsh keeps earlier immutable
    // generations (session.jsonl.zstd, session.vN...) beside the live v3 log
    // after a migration, and they replay the same history.
    if (input.agentId === "dsh") return name === "session.v3.jsonl.zstd";
    if (input.agentId === "fx" || input.agentId === "antigravity" || input.agentId === "thaura") return name === "usage.jsonl";
    if (input.agentId === "grok") return name === "unified.jsonl";
    return name.endsWith(".jsonl");
  }

  async function walk(directory: string, files: string[]) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTDIR") {
        try {
          const stat = await fs.promises.stat(directory);
          if (stat.isFile() && matches(directory)) {
            files.push(directory);
            return;
          }
        } catch {
          // The standard discovery error below is sufficient.
        }
      }
      if (code !== "ENOENT") {
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

  // DeepSeek Harness writes one Zstandard frame per append batch and
  // concatenates them in a single file, while Node's zlib decoder stops at the
  // end of the first frame. Frame boundaries are scanned structurally so each
  // frame can be decompressed on its own; a torn final frame (an interrupted
  // append) is returned separately instead of failing the whole file.
  function zstdFrames(source: Buffer) {
    const frames: Array<{ start: number; end: number }> = [];
    let offset = 0;
    while (offset < source.length) {
      const start = offset;
      if (source.length - offset < 4) return { frames, tornStart: start };
      if (source.readUInt32LE(offset) !== 0xfd2fb528) throw new Error("Invalid Zstandard frame magic.");
      offset += 4;
      if (offset === source.length) return { frames, tornStart: start };
      const descriptor = source.readUInt8(offset);
      offset += 1;
      if ((descriptor & 24) !== 0) throw new Error("Invalid Zstandard frame header.");
      const singleSegment = (descriptor & 32) !== 0;
      const contentSizeFlag = descriptor >>> 6;
      const dictionaryBytes = (descriptor & 3) === 3 ? 4 : descriptor & 3;
      const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
      const headerBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
      if (source.length - offset < headerBytes) return { frames, tornStart: start };
      offset += headerBytes;
      for (;;) {
        if (source.length - offset < 3) return { frames, tornStart: start };
        const blockHeader = source.readUIntLE(offset, 3);
        offset += 3;
        const blockType = (blockHeader >>> 1) & 3;
        if (blockType === 3) throw new Error("Invalid Zstandard block type.");
        const payloadBytes = blockType === 1 ? 1 : blockHeader >>> 3;
        if (source.length - offset < payloadBytes) return { frames, tornStart: start };
        offset += payloadBytes;
        if ((blockHeader & 1) !== 0) break;
      }
      if ((descriptor & 4) !== 0) {
        if (source.length - offset < 4) return { frames, tornStart: start };
        offset += 4;
      }
      frames.push({ start, end: offset });
    }
    return { frames };
  }

  async function* zstdLines(filePath: string) {
    if (!canDecompressZstd) throw new Error("This Node.js cannot decompress Zstandard usage logs.");
    const source = await fs.promises.readFile(filePath);
    const { frames, tornStart } = zstdFrames(source);
    for (const frame of frames) {
      yield* zlib.zstdDecompressSync(source.subarray(frame.start, frame.end)).toString("utf8").split("\n");
    }
    // The torn tail still yields the complete records written before the
    // interrupted append; the rest becomes readable once the log is repaired.
    if (tornStart !== undefined) {
      try {
        yield* zlib.zstdDecompressSync(source.subarray(tornStart), { finishFlush: zlib.constants.ZSTD_e_flush }).toString("utf8").split("\n");
      } catch { /* unreadable bytes stay unread until a later scan */ }
    }
  }

  // An attempt that never committed a message carries its usage in the
  // stream's last usage chunk; committed messages carry it on data.usage.
  function lastStreamUsage(stream: unknown) {
    if (!Array.isArray(stream)) return null;
    let usage: Record<string, unknown> | null = null;
    for (const entry of stream) {
      const chunk = object(object(entry)?.chunk);
      if (chunk?.type !== "usage") continue;
      const candidate = object(chunk.usage);
      if (candidate) usage = candidate;
    }
    return usage;
  }

  async function parseFile(filePath: string): Promise<CachedUsageRow[]> {
    const rows = new Map<string, HostUsageAggregate>();
    const events = new Map<string, CachedUsageRow>();
    const fileAccount = accountByPath.get(filePath);
    let codexModel = "codex-unknown";
    // Session-scoped project, learned from the first record that carries a
    // working directory and reused for later rows in the same file.
    let sessionProject = "Unknown";
    // dsh keeps the active request's provider/model on request/context rows;
    // settlements without a committed message fall back to it.
    let dshProvider = "unknown";
    let dshModel = "unknown";
    // A forked/seeded dsh session replays its parent's leading events before a
    // session/end-seed marker; events at or before the last marker are the
    // parent's, not this session's usage. The marker is sequenced after the
    // inherited prefix, so settlements are buffered and applied once the
    // boundary is known.
    let dshSeeded = false;
    let dshEndSeedSeq = -1;
    const dshSettlements: Array<{ seq: number; row: HostUsageAggregate }> = [];
    const lines: AsyncIterable<string> = filePath.endsWith(".zstd")
      ? zstdLines(filePath)
      : readline.createInterface({ input: fs.createReadStream(filePath, { encoding: "utf8", highWaterMark: 1024 * 1024 }), crlfDelay: Infinity });
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
          if (typeof payload.cwd === "string") sessionProject = projectName(payload.cwd);
        }
        if (value.type !== "event_msg" || payload?.type !== "token_count") continue;
        const usage = object(object(payload.info)?.last_token_usage);
        const usageDay = day(value.timestamp);
        if (!usage || !usageDay) continue;
        const inputTokens = count(usage.input_tokens);
        const cached = Math.min(inputTokens, count(usage.cached_input_tokens));
        add(rows, {
          day: usageDay, modelProviderId: "openai", model: codexModel, project: sessionProject, loggedCostUsd: null,
          account: fileAccount,
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
        const rawIdentity = typeof message.id === "string" && message.id
          ? `message:${message.id}`
          : typeof value.requestId === "string" && value.requestId ? `request:${value.requestId}` : null;
        if (typeof value.cwd === "string") sessionProject = projectName(value.cwd);
        const row: CachedUsageRow = {
          day: usageDay, modelProviderId: "anthropic", model, project: sessionProject, loggedCostUsd: null,
          uncachedInputTokens: uncached, cachedInputTokens: cached, cacheWriteTokens: writes, outputTokens: output,
          eventKey: rawIdentity ? crypto.createHash("sha256").update(rawIdentity).digest("hex") : undefined,
        };
        if (row.eventKey) mergeEvent(events, row);
        else add(rows, row);
        continue;
      }

      if (input.agentId === "grok") {
        if (value.msg !== "shell.turn.inference_done") continue;
        const usage = object(value.ctx);
        const usageDay = day(value.ts);
        if (!usage || usage.prompt_tokens === undefined || !usageDay) continue;
        const prompt = count(usage.prompt_tokens);
        const cached = Math.min(prompt, count(usage.cached_prompt_tokens));
        if (typeof value.cwd === "string") sessionProject = projectName(value.cwd);
        add(rows, {
          day: usageDay, modelProviderId: "xai", model: text(usage.model, "grok-build-0.1"), project: sessionProject, loggedCostUsd: null,
          uncachedInputTokens: prompt - cached, cachedInputTokens: cached, cacheWriteTokens: 0,
          outputTokens: count(usage.completion_tokens) + count(usage.reasoning_tokens),
        });
        continue;
      }

      if (input.agentId === "fx") {
        if (value.kind !== "generation") continue;
        const fact = object(value.fact);
        const usageDay = day(fact?.created_at_ms);
        if (!fact || !usageDay) continue;
        const model = text(fact.model, "unknown");
        const separator = model.indexOf("/");
        const inputTokens = count(fact.input_tokens);
        const cached = Math.min(inputTokens, count(fact.cache_read_tokens));
        const cacheWrite = Math.min(inputTokens - cached, count(fact.cache_write_tokens));
        add(rows, {
          day: usageDay,
          modelProviderId: separator > 0 ? model.slice(0, separator) : "unknown",
          model,
          project: projectName(fact.cwd ?? fact.workspace ?? value.cwd),
          loggedCostUsd: finite(fact.total_cost),
          uncachedInputTokens: inputTokens - cached - cacheWrite,
          cachedInputTokens: cached,
          cacheWriteTokens: cacheWrite,
          outputTokens: count(fact.output_tokens),
        });
        continue;
      }

      if (input.agentId === "antigravity") {
        // Written by bb-plugin-antigravity-acp's provider bridge, one line
        // per turn it forwards to the local `agy` CLI (agy has no session
        // log of its own in this shape — the bridge is the source of truth).
        if (value.kind !== "generation") continue;
        const fact = object(value.fact);
        const usageDay = day(fact?.created_at_ms);
        if (!fact || !usageDay) continue;
        const inputTokens = count(fact.input_tokens);
        const cached = Math.min(inputTokens, count(fact.cache_read_tokens));
        add(rows, {
          day: usageDay,
          modelProviderId: text(fact.provider, "google"),
          model: text(fact.model, "unknown"),
          project: projectName(fact.cwd ?? fact.workspace ?? value.cwd),
          loggedCostUsd: finite(fact.total_cost),
          uncachedInputTokens: inputTokens - cached,
          cachedInputTokens: cached,
          cacheWriteTokens: 0,
          outputTokens: count(fact.output_tokens),
        });
        continue;
      }

      if (input.agentId === "thaura") {
        // Written by the Thaura integration, one line per API call it makes
        // to thaura.ai (OpenAI-compatible usage shape).
        if (value.kind !== "generation") continue;
        const fact = object(value.fact);
        const usageDay = day(fact?.created_at_ms);
        if (!fact || !usageDay) continue;
        const model = text(fact.model, "thaura");
        const inputTokens = count(fact.input_tokens);
        const cached = Math.min(inputTokens, count(fact.cache_read_tokens));
        add(rows, {
          day: usageDay,
          modelProviderId: "thaura",
          model,
          project: projectName(fact.cwd ?? value.cwd),
          loggedCostUsd: finite(fact.total_cost),
          uncachedInputTokens: inputTokens - cached,
          cachedInputTokens: cached,
          cacheWriteTokens: 0,
          outputTokens: count(fact.output_tokens),
        });
        continue;
      }

      if (input.agentId === "pi" || input.agentId === "prime") {
        const directory = value.cwd ?? value.directory ?? object(value.session)?.cwd;
        if (typeof directory === "string") sessionProject = projectName(directory);
        if (value.type !== "message") continue;
        const message = object(value.message);
        const usage = object(message?.usage);
        const usageDay = day(value.timestamp ?? message?.timestamp);
        if (!message || message.role !== "assistant" || !usage || !usageDay) continue;
        const loggedCostUsd = finite(object(usage.cost)?.total);
        const hasTokens = count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite) + count(usage.output) > 0;
        if (!hasTokens && !(loggedCostUsd !== null && loggedCostUsd > 0)) continue;
        add(rows, {
          day: usageDay,
          modelProviderId: text(message.provider, "unknown"),
          model: text(message.responseModel, text(message.model, "unknown")),
          project: sessionProject,
          loggedCostUsd,
          uncachedInputTokens: count(usage.input), cachedInputTokens: count(usage.cacheRead),
          cacheWriteTokens: count(usage.cacheWrite), outputTokens: count(usage.output),
        });
      }

      if (input.agentId === "dsh") {
        if (value.type === "session") {
          dshSeeded = value.isSeeded === true;
          if (typeof value.cwd === "string") sessionProject = projectName(value.cwd);
          continue;
        }
        if (value.type === "session/end-seed") {
          // Only a tagged marker is a fork boundary; dsh also writes untagged
          // end-seed records at ordinary resume/restore boundaries.
          if (object(value.data)?.inherited === true && typeof value.seq === "number") {
            dshEndSeedSeq = Math.max(dshEndSeedSeq, value.seq);
          }
          continue;
        }
        const data = object(value.data);
        if (value.type === "request/context" && data) {
          dshProvider = text(data.provider, dshProvider);
          dshModel = text(data.model, dshModel);
          continue;
        }
        if (value.type !== "assistant/message" && value.type !== "assistant/attempt") continue;
        const usage = object(data?.usage) ?? lastStreamUsage(data?.stream);
        const usageDay = day(value.time);
        if (!usage || !usageDay) continue;
        const inputTokens = count(usage.inputTokens);
        const cached = count(usage.cacheReadTokens);
        const writes = count(usage.cacheWriteTokens);
        const output = count(usage.outputTokens);
        if (inputTokens + cached + writes + output === 0) continue;
        const source = object(object(data?.message)?.source);
        const replay = object(object(source?.replayState)?.response);
        dshSettlements.push({
          seq: count(value.seq),
          row: {
            day: usageDay,
            modelProviderId: text(source?.provider ?? replay?.provider, dshProvider),
            model: text(replay?.responseModel ?? source?.model ?? replay?.model, dshModel),
            project: sessionProject,
            loggedCostUsd: null,
            uncachedInputTokens: inputTokens, cachedInputTokens: cached,
            cacheWriteTokens: writes, outputTokens: output,
          },
        });
        continue;
      }
    }
    for (const settlement of dshSettlements) {
      if (settlement.seq > (dshSeeded ? dshEndSeedSeq : -1)) add(rows, settlement.row);
    }
    return input.agentId === "claude" ? [...events.values(), ...rows.values()] : [...rows.values()];
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
  const accountDiscovered: string[] = [];
  if (accountRoot) {
    let accountEntries: import("node:fs").Dirent[] = [];
    try {
      accountEntries = await fs.promises.readdir(accountRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        discoveryFailed = true;
        failures.push("A usage directory could not be read.");
      }
    }
    for (const entry of accountEntries) {
      // Dirent type bits describe the link itself, so a symlinked profile home
      // is followed here; the inode dedup below keeps an account aliased to the
      // primary home from being counted twice.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const files: string[] = [];
      await walk(path.join(accountRoot, entry.name, "sessions"), files);
      for (const filePath of files) accountByPath.set(filePath, entry.name);
      accountDiscovered.push(...files);
    }
  }
  // Primary roots come first so the inode dedup attributes an aliased file to
  // the primary home rather than to whichever account path happens to sort
  // earlier.
  const uniquePaths = [...new Set(discovered)].sort().concat([...new Set(accountDiscovered)].sort());
  const nextFiles: Record<string, CacheEntry> = {};
  const allRows = new Map<string, HostUsageAggregate>();
  const allEvents = new Map<string, CachedUsageRow>();
  const seenFiles = new Set<string>();
  let fileCount = 0;
  let changedFileCount = 0;
  let reusedFileCount = 0;

  for (const filePath of uniquePaths) {
    const sourceId = crypto.createHash("sha256").update(filePath).digest("hex");
    const prior = cache.files[sourceId];
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.mtimeMs < cutoffMs) continue;
      const fileIdentity = `${stat.dev}:${stat.ino}`;
      if (seenFiles.has(fileIdentity)) continue;
      seenFiles.add(fileIdentity);
      fileCount += 1;
      const signature = `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
      if (prior?.signature === signature && Array.isArray(prior.rows) && prior.rows.every(validRow)) {
        nextFiles[sourceId] = prior;
        for (const row of prior.rows) row.eventKey ? mergeEvent(allEvents, row) : add(allRows, row);
        reusedFileCount += 1;
        continue;
      }
      const rows = await parseFile(filePath);
      nextFiles[sourceId] = { signature, rows };
      for (const row of rows) row.eventKey ? mergeEvent(allEvents, row) : add(allRows, row);
      changedFileCount += 1;
    } catch {
      // Absolute host paths and raw errors must not cross the host boundary;
      // this string is persisted in sync state and shown in the dashboard.
      failures.push(!canDecompressZstd && filePath.endsWith(".zstd")
        ? "A Zstandard usage log needs Node.js 22.15+ on this host."
        : "A usage log could not be read.");
      if (prior && Array.isArray(prior.rows) && prior.rows.every(validRow)) {
        nextFiles[sourceId] = prior;
        for (const row of prior.rows) row.eventKey ? mergeEvent(allEvents, row) : add(allRows, row);
      }
    }
  }

  if (discoveryFailed) {
    for (const [sourceId, prior] of Object.entries(cache.files)) {
      if (nextFiles[sourceId] || !Array.isArray(prior.rows) || !prior.rows.every(validRow)) continue;
      nextFiles[sourceId] = prior;
      for (const row of prior.rows) row.eventKey ? mergeEvent(allEvents, row) : add(allRows, row);
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

  for (const row of allEvents.values()) add(allRows, row);
  const rows = [...allRows.values()].sort((a, b) => a.day.localeCompare(b.day)
    || a.modelProviderId.localeCompare(b.modelProviderId) || a.model.localeCompare(b.model)
    || a.project.localeCompare(b.project));
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
