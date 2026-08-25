import { normalizeProviderId, resolvePricing, type PricingStatus } from "./lib/pricing";

export type AgentId = "codex" | "claude" | "fx" | "grok" | "opencode" | "pi" | "prime" | "antigravity";

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
  project: string;
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
  day?: string;
  agentId: AgentId;
  agentName: string;
  modelProviderId: string;
  model: string;
  project?: string;
  loggedCostUsd?: number | null;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costMode?: "estimate-or-logged" | "logged-only" | "positive-logged-only";
};

type ParseContext = { machineId: string; machineName: string };

export type HostUsageAggregate = {
  day: string;
  modelProviderId: string;
  model: string;
  project: string;
  loggedCostUsd: number | null;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
};

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

function localDayOf(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value.slice(0, 10)
    : `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
}

// Only the working directory's final segment is recorded, so usage can be
// grouped by project without storing the machine's directory layout.
export function projectName(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return "Unknown";
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  const segment = normalized.slice(normalized.lastIndexOf("/") + 1).trim();
  return segment ? segment.slice(0, 80) : "Unknown";
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
  const positiveLogged = logged !== null && logged > 0 ? logged : null;
  const loggedOnly = input.costMode === "logged-only";
  const recordedOnly = loggedOnly || input.costMode === "positive-logged-only";
  const estimated = !recordedOnly && pricing.price
    ? ((uncached * pricing.price.input) + (cached * pricing.price.cached) + (writes * pricing.price.cacheWrite) + (output * pricing.price.output)) / 1_000_000
    : null;
  const effectiveLogged = input.costMode === "positive-logged-only"
    ? positiveLogged
    : loggedOnly && logged !== null ? Math.max(0, logged) : logged;
  const timestamp = isoTimestamp(input.timestamp) ?? input.timestamp;
  return {
    eventKey: input.eventKey,
    timestamp,
    day: input.day ?? localDayOf(timestamp),
    agentId: input.agentId,
    agentName: input.agentName,
    modelProviderId: pricing.modelProviderId,
    modelProviderName: pricing.modelProviderName,
    machineId: context.machineId,
    machineName: context.machineName,
    model: input.model,
    project: text(input.project, "Unknown"),
    costUsd: Number((estimated ?? effectiveLogged ?? 0).toFixed(6)),
    loggedCostUsd: effectiveLogged === null ? null : Number(Math.max(0, effectiveLogged).toFixed(6)),
    pricingStatus: estimated !== null ? pricing.status : effectiveLogged !== null ? "logged" : "unknown",
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
  let project = "Unknown";
  for (const { value, line } of lines(content)) {
    const payload = object(value.payload);
    if ((value.type === "turn_context" || value.type === "session_meta") && payload) {
      model = text(payload.model, model);
      if (typeof payload.cwd === "string") project = projectName(payload.cwd);
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
      modelProviderId: "openai", model, project, uncachedInputTokens: input - cached, cachedInputTokens: cached,
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
      modelProviderId: "anthropic", model, project: projectName(value.cwd), uncachedInputTokens: count(usage.input_tokens),
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
      project: projectName(value.cwd), uncachedInputTokens: input - cached, cachedInputTokens: cached, cacheWriteTokens: 0,
      outputTokens: count(usage.completion_tokens) + count(usage.reasoning_tokens),
    }, context));
  }
  return records;
}

function parsePiCompatible(
  content: string,
  context: ParseContext,
  agentId: "pi" | "prime",
  agentName: "Pi" | "Prime Agent",
): UsageRecord[] {
  const records: UsageRecord[] = [];
  let sessionId = "session-unknown";
  let project = "Unknown";
  for (const { value, line } of lines(content)) {
    if (value.type === "session") sessionId = text(value.id, sessionId);
    const directory = value.cwd ?? value.directory ?? object(value.session)?.cwd;
    if (typeof directory === "string") project = projectName(directory);
    if (value.type !== "message") continue;
    const message = object(value.message);
    const usage = object(message?.usage);
    const timestamp = isoTimestamp(value.timestamp ?? message?.timestamp);
    if (!message || message.role !== "assistant" || !usage || !timestamp) continue;
    const loggedCostUsd = finite(object(usage.cost)?.total);
    const hasTokens = count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite) + count(usage.output) > 0;
    if (!hasTokens && !(loggedCostUsd !== null && loggedCostUsd > 0)) continue;
    records.push(usageRecord({
      eventKey: `${agentId}:${sessionId}:${text(value.id, String(line))}`, timestamp, agentId, agentName,
      modelProviderId: text(message.provider, "unknown"), model: text(message.responseModel, text(message.model, "unknown")),
      project, loggedCostUsd, costMode: "positive-logged-only",
      uncachedInputTokens: count(usage.input),
      cachedInputTokens: count(usage.cacheRead), cacheWriteTokens: count(usage.cacheWrite), outputTokens: count(usage.output),
    }, context));
  }
  return records;
}

export function parsePi(content: string, context: ParseContext): UsageRecord[] {
  return parsePiCompatible(content, context, "pi", "Pi");
}

export function parsePrime(content: string, context: ParseContext): UsageRecord[] {
  return parsePiCompatible(content, context, "prime", "Prime Agent");
}

export function parseOpenCode(content: string, context: ParseContext): UsageRecord[] {
  let values: unknown;
  try {
    values = JSON.parse(content.trim() || "[]");
  } catch {
    throw new Error("OpenCode returned malformed JSON.");
  }
  if (!Array.isArray(values)) throw new Error("OpenCode returned an unexpected result shape.");

  return values.map((raw, index) => {
    const row = object(raw);
    const day = text(row?.day, "");
    const timestamp = isoTimestamp(`${day}T00:00:00Z`);
    const modelProvider = text(row?.modelProviderId, "");
    const model = text(row?.model, "");
    const loggedCost = finite(row?.loggedCostUsd);
    const tokenValues = [
      row?.inputTokens,
      row?.cachedInputTokens,
      row?.cacheWriteTokens,
      row?.outputTokens,
      row?.reasoningTokens,
    ].map(finite);
    if (!row || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !timestamp || !modelProvider || !model
      || loggedCost === null
      || tokenValues.some((value) => value === null || value < 0 || !Number.isInteger(value))) {
      throw new Error(`OpenCode returned an invalid aggregate row at index ${index}.`);
    }
    const modelProviderId = normalizeProviderId(modelProvider);
    const [input, cached, cacheWrite, output, reasoning] = tokenValues as number[];
    return usageRecord({
      eventKey: `opencode:${context.machineId}:${day}:${encodeURIComponent(modelProviderId)}:${encodeURIComponent(model)}`,
      timestamp, day, agentId: "opencode", agentName: "OpenCode", modelProviderId, model,
      loggedCostUsd: loggedCost, costMode: "positive-logged-only", uncachedInputTokens: input,
      cachedInputTokens: cached, cacheWriteTokens: cacheWrite, outputTokens: output + reasoning,
    }, context);
  });
}

export function parseHostUsageAggregates(content: string, agentId: Exclude<AgentId, "opencode">, context: ParseContext): UsageRecord[] {
  let values: unknown;
  try {
    values = JSON.parse(content.trim() || "[]");
  } catch {
    throw new Error(`${agentId} host scan returned malformed JSON.`);
  }
  if (!Array.isArray(values)) throw new Error(`${agentId} host scan returned an unexpected result shape.`);

  const agentName = agentId === "codex" ? "Codex"
    : agentId === "claude" ? "Claude Code"
    : agentId === "grok" ? "Grok Agent"
    : agentId === "fx" ? "FX"
    : agentId === "prime" ? "Prime Agent"
    : agentId === "antigravity" ? "Antigravity"
    : "Pi";

  return values.flatMap((raw) => {
    const row = object(raw);
    if (!row) return [];
    const day = text(row.day, "");
    const timestamp = isoTimestamp(`${day}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !timestamp) return [];
    const modelProviderId = normalizeProviderId(text(row.modelProviderId, "unknown"));
    const model = text(row.model, "unknown");
    const project = text(row.project, "Unknown");
    return [usageRecord({
      eventKey: `${agentId}:${context.machineId}:${day}:${encodeURIComponent(modelProviderId)}:${encodeURIComponent(model)}:${encodeURIComponent(project)}`,
      timestamp,
      agentId,
      agentName,
      modelProviderId,
      model,
      project,
      loggedCostUsd: finite(row.loggedCostUsd),
      costMode: agentId === "fx" ? "logged-only"
        : agentId === "prime" || agentId === "pi" ? "positive-logged-only"
        : undefined,
      uncachedInputTokens: count(row.uncachedInputTokens),
      cachedInputTokens: count(row.cachedInputTokens),
      cacheWriteTokens: count(row.cacheWriteTokens),
      outputTokens: count(row.outputTokens),
    }, context)];
  });
}
