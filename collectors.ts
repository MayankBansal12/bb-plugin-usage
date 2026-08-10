import { priceFor, PRICING_REVISION, PRICING_VERSION, type PricingProviderId } from "./lib/pricing";

export type ProviderId = PricingProviderId;
export { PRICING_REVISION, PRICING_VERSION };

export type UsageRecord = {
  eventKey: string;
  timestamp: string;
  day: string;
  providerId: ProviderId;
  providerName: string;
  machineId: string;
  machineName: string;
  model: string;
  costUsd: number;
  cacheSavingsUsd: number;
  processedTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
};

function cost(providerId: ProviderId, model: string, uncached: number, cached: number, writes: number, output: number) {
  const price = priceFor(providerId, model);
  return Number((((uncached * price.input) + (cached * price.cached) + (writes * price.cacheWrite) + (output * price.output)) / 1_000_000).toFixed(6));
}

function cacheSavings(providerId: ProviderId, model: string, cached: number) {
  const price = priceFor(providerId, model);
  return Number(((cached * Math.max(0, price.input - price.cached)) / 1_000_000).toFixed(6));
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function string(value: unknown, fallback: string) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
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

type ParseContext = { machineId: string; machineName: string };

export function parseCodex(content: string, context: ParseContext): UsageRecord[] {
  const records: UsageRecord[] = [];
  let model = "codex-unknown";
  let sessionId = "session-unknown";

  for (const { value, line } of lines(content)) {
    const payload = object(value.payload);
    if ((value.type === "turn_context" || value.type === "session_meta") && payload) {
      model = string(payload.model, model);
      if (value.type === "session_meta") sessionId = string(payload.id, sessionId);
    }
    if (value.type !== "event_msg" || payload?.type !== "token_count") continue;

    const info = object(payload.info);
    const usage = object(info?.last_token_usage);
    if (!usage) continue;
    const timestamp = string(value.timestamp, "");
    if (!timestamp) continue;

    const input = number(usage.input_tokens);
    const cached = Math.min(input, number(usage.cached_input_tokens));
    const writes = number(usage.cache_write_input_tokens);
    const uncached = Math.max(0, input - cached);
    const output = number(usage.output_tokens);

    records.push({
      eventKey: `codex:${sessionId}:${timestamp}:${line}`,
      timestamp,
      day: timestamp.slice(0, 10),
      providerId: "codex",
      providerName: "Codex",
      machineId: context.machineId,
      machineName: context.machineName,
      model,
      costUsd: cost("codex", model, uncached, cached, writes, output),
      cacheSavingsUsd: cacheSavings("codex", model, cached),
      processedTokens: input + writes + output,
      cachedInputTokens: cached,
      cacheWriteTokens: writes,
      uncachedInputTokens: uncached,
      outputTokens: output,
    });
  }
  return records;
}

export function parseClaude(content: string, context: ParseContext): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const { value, line } of lines(content)) {
    if (value.type !== "assistant") continue;
    const message = object(value.message);
    const usage = object(message?.usage);
    if (!message || !usage) continue;
    const timestamp = string(value.timestamp, "");
    if (!timestamp) continue;

    const model = string(message.model, "claude-unknown");
    const uncached = number(usage.input_tokens);
    const cached = number(usage.cache_read_input_tokens);
    const writes = number(usage.cache_creation_input_tokens);
    const output = number(usage.output_tokens);
    const processed = uncached + cached + writes + output;
    if (model === "<synthetic>" && processed === 0) continue;
    const messageId = string(message.id, String(line));

    records.push({
      eventKey: `claude:${messageId}`,
      timestamp,
      day: timestamp.slice(0, 10),
      providerId: "claude",
      providerName: "Claude Code",
      machineId: context.machineId,
      machineName: context.machineName,
      model,
      costUsd: cost("claude", model, uncached, cached, writes, output),
      cacheSavingsUsd: cacheSavings("claude", model, cached),
      processedTokens: processed,
      cachedInputTokens: cached,
      cacheWriteTokens: writes,
      uncachedInputTokens: uncached,
      outputTokens: output,
    });
  }
  return records;
}

export function parseGrok(content: string, context: ParseContext): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const { value, line } of lines(content)) {
    if (value.msg !== "shell.turn.inference_done") continue;
    const usage = object(value.ctx);
    if (!usage || usage.prompt_tokens === undefined) continue;
    const timestamp = string(value.ts, "");
    if (!timestamp) continue;

    const model = string(usage.model, "grok-build-0.1");
    const input = number(usage.prompt_tokens);
    const cached = Math.min(input, number(usage.cached_prompt_tokens));
    const uncached = Math.max(0, input - cached);
    const output = number(usage.completion_tokens) + number(usage.reasoning_tokens);
    const sessionId = string(value.sid, "session");

    records.push({
      eventKey: `grok:${sessionId}:${timestamp}:${number(usage.loop_index) || line}`,
      timestamp,
      day: timestamp.slice(0, 10),
      providerId: "grok",
      providerName: "Grok Agent",
      machineId: context.machineId,
      machineName: context.machineName,
      model,
      costUsd: cost("grok", model, uncached, cached, 0, output),
      cacheSavingsUsd: cacheSavings("grok", model, cached),
      processedTokens: input + output,
      cachedInputTokens: cached,
      cacheWriteTokens: 0,
      uncachedInputTokens: uncached,
      outputTokens: output,
    });
  }
  return records;
}
