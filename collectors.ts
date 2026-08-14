import { normalizeProviderId, resolvePricing, type PricingStatus } from "./lib/pricing";

export type AgentId = "codex" | "claude" | "grok" | "opencode" | "pi";

export type UsageRecord = {
  eventKey: string;
  timestamp: string;
  day: string;
  agentId: AgentId;
  agentName: string;
  modelProviderId: string;
  modelProviderName: string;
  machineId: string;
  machineName: string;
  model: string;
  costUsd: number;
  loggedCostUsd: number | null;
  pricingStatus: PricingStatus;
  cacheSavingsUsd: number;
  processedTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
};

type UsageInput = {
  eventKey: string;
  timestamp: string;
  agentId: AgentId;
  agentName: string;
  modelProviderId: string;
  model: string;
  loggedCostUsd?: number | null;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
};

type ParseContext = { machineId: string; machineName: string };

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
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function lines(content: string) {
  const parsed: Array<{ value: Record<string, unknown>; line: number }> = [];
  content.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const value = object(JSON.parse(line));
      if (value) parsed.push({ value, line: index + 1 });
    } catch {
      // Active JSONL files may end with an incomplete line; the next sync retries it.
    }
  });
  return parsed;
}

function usageRecord(input: UsageInput, context: ParseContext): UsageRecord {
  const pricing = resolvePricing(input.modelProviderId, input.model);
  const uncached = count(input.uncachedInputTokens);
  const cached = count(input.cachedInputTokens);
  const writes = count(input.cacheWriteTokens);
  const output = count(input.outputTokens);
  const logged = finite(input.loggedCostUsd);
  const estimated = pricing.price
    ? ((uncached * pricing.price.input) + (cached * pricing.price.cached) + (writes * pricing.price.cacheWrite) + (output * pricing.price.output)) / 1_000_000
    : null;
  const timestamp = isoTimestamp(input.timestamp) ?? input.timestamp;
  return {
    eventKey: input.eventKey,
    timestamp,
    day: timestamp.slice(0, 10),
    agentId: input.agentId,
    agentName: input.agentName,
    modelProviderId: pricing.modelProviderId,
    modelProviderName: pricing.modelProviderName,
    machineId: context.machineId,
    machineName: context.machineName,
    model: input.model,
    costUsd: Number((estimated ?? logged ?? 0).toFixed(6)),
    loggedCostUsd: logged === null ? null : Number(Math.max(0, logged).toFixed(6)),
    pricingStatus: estimated !== null ? pricing.status : logged !== null ? "logged" : "unknown",
    cacheSavingsUsd: pricing.price ? Number(((cached * Math.max(0, pricing.price.input - pricing.price.cached)) / 1_000_000).toFixed(6)) : 0,
    processedTokens: uncached + cached + writes + output,
    cachedInputTokens: cached,
    cacheWriteTokens: writes,
    uncachedInputTokens: uncached,
    outputTokens: output,
  };
}

export function parseCodex(content: string, context: ParseContext): UsageRecord[] {
  const records: UsageRecord[] = [];
  let model = "codex-unknown";
  let sessionId = "session-unknown";
  for (const { value, line } of lines(content)) {
    const payload = object(value.payload);
    if ((value.type === "turn_context" || value.type === "session_meta") && payload) {
      model = text(payload.model, model);
      if (value.type === "session_meta") sessionId = text(payload.id, sessionId);
    }
    if (value.type !== "event_msg" || payload?.type !== "token_count") continue;
    const usage = object(object(payload.info)?.last_token_usage);
    const timestamp = isoTimestamp(value.timestamp);
    if (!usage || !timestamp) continue;
    const input = count(usage.input_tokens);
    const cached = Math.min(input, count(usage.cached_input_tokens));
    records.push(usageRecord({
      eventKey: `codex:${sessionId}:${timestamp}:${line}`, timestamp, agentId: "codex", agentName: "Codex",
      modelProviderId: "openai", model, uncachedInputTokens: input - cached, cachedInputTokens: cached,
      cacheWriteTokens: count(usage.cache_write_input_tokens), outputTokens: count(usage.output_tokens),
    }, context));
  }
  return records;
}

export function parseClaude(content: string, context: ParseContext): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const { value, line } of lines(content)) {
    if (value.type !== "assistant") continue;
    const message = object(value.message);
    const usage = object(message?.usage);
    const timestamp = isoTimestamp(value.timestamp);
    if (!message || !usage || !timestamp) continue;
    const model = text(message.model, "claude-unknown");
    const processed = count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.output_tokens);
    if (model === "<synthetic>" && processed === 0) continue;
    records.push(usageRecord({
      eventKey: `claude:${text(message.id, String(line))}`, timestamp, agentId: "claude", agentName: "Claude Code",
      modelProviderId: "anthropic", model, uncachedInputTokens: count(usage.input_tokens),
      cachedInputTokens: count(usage.cache_read_input_tokens), cacheWriteTokens: count(usage.cache_creation_input_tokens),
      outputTokens: count(usage.output_tokens),
    }, context));
  }
  return records;
}

export function parseGrok(content: string, context: ParseContext): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const { value, line } of lines(content)) {
    if (value.msg !== "shell.turn.inference_done") continue;
    const usage = object(value.ctx);
    const timestamp = isoTimestamp(value.ts);
    if (!usage || usage.prompt_tokens === undefined || !timestamp) continue;
    const input = count(usage.prompt_tokens);
    const cached = Math.min(input, count(usage.cached_prompt_tokens));
    records.push(usageRecord({
      eventKey: `grok:${text(value.sid, "session")}:${timestamp}:${count(usage.loop_index) || line}`, timestamp,
      agentId: "grok", agentName: "Grok Agent", modelProviderId: "xai", model: text(usage.model, "grok-build-0.1"),
      uncachedInputTokens: input - cached, cachedInputTokens: cached, cacheWriteTokens: 0,
      outputTokens: count(usage.completion_tokens) + count(usage.reasoning_tokens),
    }, context));
  }
  return records;
}

export function parsePi(content: string, context: ParseContext): UsageRecord[] {
  const records: UsageRecord[] = [];
  let sessionId = "session-unknown";
  for (const { value, line } of lines(content)) {
    if (value.type === "session") sessionId = text(value.id, sessionId);
    if (value.type !== "message") continue;
    const message = object(value.message);
    const usage = object(message?.usage);
    const timestamp = isoTimestamp(value.timestamp ?? message?.timestamp);
    if (!message || message.role !== "assistant" || !usage || !timestamp) continue;
    records.push(usageRecord({
      eventKey: `pi:${sessionId}:${text(value.id, String(line))}`, timestamp, agentId: "pi", agentName: "Prime Agent",
      modelProviderId: text(message.provider, "unknown"), model: text(message.responseModel, text(message.model, "unknown")),
      loggedCostUsd: finite(object(usage.cost)?.total), uncachedInputTokens: count(usage.input),
      cachedInputTokens: count(usage.cacheRead), cacheWriteTokens: count(usage.cacheWrite), outputTokens: count(usage.output),
    }, context));
  }
  return records;
}

export function parseOpenCode(content: string, context: ParseContext): UsageRecord[] {
  let values: unknown;
  try {
    values = JSON.parse(content.trim() || "[]");
  } catch {
    throw new Error("OpenCode returned malformed JSON.");
  }
  if (!Array.isArray(values)) throw new Error("OpenCode returned an unexpected result shape.");

  return values.flatMap((raw) => {
    const row = object(raw);
    if (!row) return [];
    const day = text(row.day, "");
    const timestamp = isoTimestamp(`${day}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !timestamp) return [];
    const modelProviderId = normalizeProviderId(text(row.modelProviderId, "unknown"));
    const model = text(row.model, "unknown");
    const input = count(row.inputTokens);
    const cached = Math.min(input, count(row.cachedInputTokens));
    return [usageRecord({
      eventKey: `opencode:${context.machineId}:${day}:${modelProviderId}:${model}`, timestamp, agentId: "opencode", agentName: "OpenCode",
      modelProviderId, model, loggedCostUsd: finite(row.loggedCostUsd), uncachedInputTokens: input - cached,
      cachedInputTokens: cached, cacheWriteTokens: count(row.cacheWriteTokens),
      outputTokens: count(row.outputTokens) + count(row.reasoningTokens),
    }, context)];
  });
}
