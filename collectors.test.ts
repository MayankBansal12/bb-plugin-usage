import { describe, expect, it } from "vitest";
import { parseClaude, parseCodex, parseGrok, parseHostUsageAggregates, parseOpenCode, parsePi, parsePrime } from "./collectors";

const machine = { machineId: "machine-a", machineName: "Machine A" };

describe("usage collectors", () => {
  it("parses Codex usage and separates agent from model provider", () => {
    const content = [
      { timestamp: "2026-08-09T00:00:00Z", type: "session_meta", payload: { id: "session-1" } },
      { timestamp: "2026-08-09T00:00:00Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      { timestamp: "2026-08-09T00:00:01Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 5, output_tokens: 20 } } } },
    ].map(JSON.stringify).join("\n");
    expect(parseCodex(content, machine)[0]).toMatchObject({
      agentId: "codex", modelProviderId: "openai", model: "gpt-5.6-sol",
      processedTokens: 125, cachedInputTokens: 60, uncachedInputTokens: 40,
    });
  });

  it("parses Claude cache reads and writes without retaining content", () => {
    const content = JSON.stringify({
      type: "assistant", timestamp: "2026-08-09T00:00:00Z",
      message: { id: "message-1", model: "claude-sonnet-5", content: "must not be retained", usage: { input_tokens: 40, cache_read_input_tokens: 60, cache_creation_input_tokens: 5, output_tokens: 20 } },
    });
    const record = parseClaude(content, machine)[0]!;
    expect(record).toMatchObject({ agentId: "claude", modelProviderId: "anthropic", processedTokens: 125, cacheWriteTokens: 5 });
    expect(JSON.stringify(record)).not.toContain("must not be retained");
  });

  it("labels usage by project without retaining the full working directory", () => {
    const codex = [
      { timestamp: "2026-08-09T00:00:00Z", type: "session_meta", payload: { id: "session-1", cwd: "/home/ai/code/bb-plugin-usage" } },
      { timestamp: "2026-08-09T00:00:00Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      { timestamp: "2026-08-09T00:00:01Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10, output_tokens: 2 } } } },
    ].map(JSON.stringify).join("\n");
    const codexRecord = parseCodex(codex, machine)[0]!;
    expect(codexRecord.project).toBe("bb-plugin-usage");
    expect(JSON.stringify(codexRecord)).not.toContain("/home/ai/code");

    const claude = JSON.stringify({
      type: "assistant", timestamp: "2026-08-09T00:00:00Z", cwd: "/home/ai/code/usage-redesign/",
      message: { id: "message-2", model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 2 } },
    });
    expect(parseClaude(claude, machine)[0]!.project).toBe("usage-redesign");
  });

  it("falls back to an unknown project when no working directory is recorded", () => {
    const content = JSON.stringify({
      type: "assistant", timestamp: "2026-08-09T00:00:00Z",
      message: { id: "message-3", model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 2 } },
    });
    expect(parseClaude(content, machine)[0]!.project).toBe("Unknown");
  });

  it("ignores zero-token synthetic Claude messages and malformed JSONL tails", () => {
    const content = `${JSON.stringify({ type: "assistant", timestamp: "2026-08-09T00:00:00Z", message: { id: "status", model: "<synthetic>", usage: {} } })}\n{"incomplete"`;
    expect(parseClaude(content, machine)).toEqual([]);
  });

  it("parses Grok reasoning as output", () => {
    const content = JSON.stringify({
      ts: "2026-08-09T00:00:00Z", sid: "session-2", msg: "shell.turn.inference_done",
      ctx: { loop_index: 3, prompt_tokens: 100, cached_prompt_tokens: 60, completion_tokens: 15, reasoning_tokens: 5 },
    });
    expect(parseGrok(content, machine)[0]).toMatchObject({ agentId: "grok", modelProviderId: "xai", processedTokens: 120, outputTokens: 20 });
  });

  it("parses Pi's provider, token buckets, and logged cost", () => {
    const content = [
      { type: "session", version: 3, id: "pi-session", timestamp: "2026-08-09T00:00:00Z" },
      { type: "message", id: "entry-1", timestamp: "2026-08-09T00:00:01Z", message: {
        role: "assistant", provider: "google", model: "gemini-2.5-pro", content: "not retained",
        usage: { input: 40, output: 20, cacheRead: 60, cacheWrite: 5, totalTokens: 125, cost: { total: 0.0012 } },
      } },
    ].map(JSON.stringify).join("\n");
    const record = parsePi(content, machine)[0]!;
    expect(record).toMatchObject({ eventKey: "pi:pi-session:entry-1", agentId: "pi", modelProviderId: "google", loggedCostUsd: 0.0012, processedTokens: 125 });
    expect(JSON.stringify(record)).not.toContain("not retained");
  });

  it("parses Prime Agent as a distinct agent with Pi-compatible usage", () => {
    const content = [
      { type: "session", version: 3, id: "prime-session", timestamp: "2026-08-09T00:00:00Z" },
      { type: "message", id: "entry-1", timestamp: "2026-08-09T00:00:01Z", message: {
        role: "assistant", provider: "prime-inference", model: "openai/gpt-5.5", content: "not retained",
        usage: { input: 40, output: 20, cacheRead: 60, cacheWrite: 5, totalTokens: 125, cost: { total: 0.0012 } },
      } },
      { type: "child_usage_attributed", id: "attribution-1", timestamp: "2026-08-09T00:00:02Z", targetId: "entry-1", aggregateUsage: {
        input: 400, output: 200, cacheRead: 600, cacheWrite: 50, cost: { total: 0.012 },
      } },
    ].map(JSON.stringify).join("\n");
    const record = parsePrime(content, machine)[0]!;
    expect(record).toMatchObject({
      eventKey: "prime:prime-session:entry-1", agentId: "prime", agentName: "Prime Agent",
      modelProviderId: "prime-inference", model: "openai/gpt-5.5", loggedCostUsd: 0.0012, processedTokens: 125,
    });
    expect(JSON.stringify(record)).not.toContain("not retained");
  });

  it("parses OpenCode metadata aggregates and rejects malformed output", () => {
    const content = JSON.stringify([{ day: "2026-08-09", modelProviderId: "anthropic", model: "claude-sonnet-5", loggedCostUsd: 0.02, inputTokens: 100, cachedInputTokens: 60, cacheWriteTokens: 5, outputTokens: 15, reasoningTokens: 5 }]);
    expect(parseOpenCode(content, machine)[0]).toMatchObject({
      eventKey: "opencode:machine-a:2026-08-09:anthropic:claude-sonnet-5", agentId: "opencode",
      modelProviderId: "anthropic", processedTokens: 185, cachedInputTokens: 60, uncachedInputTokens: 100,
      outputTokens: 20, costUsd: 0.02, loggedCostUsd: 0.02, pricingStatus: "logged", cacheSavingsUsd: 0.000108,
    });
    expect(() => parseOpenCode("not-json", machine)).toThrow("malformed JSON");
    expect(() => parseOpenCode(JSON.stringify([{}]), machine)).toThrow("invalid aggregate row at index 0");
    expect(() => parseOpenCode(JSON.stringify([{ day: "2026-08-09" }]), machine)).toThrow("invalid aggregate row at index 0");
    expect(parseOpenCode("[]", machine)).toEqual([]);
  });

  it("leaves OpenCode cost unknown when the agent did not record a positive cost", () => {
    const content = JSON.stringify([{
      day: "2026-08-09", modelProviderId: "openai", model: "gpt-5.6-sol", loggedCostUsd: 0,
      inputTokens: 100, cachedInputTokens: 60, cacheWriteTokens: 5, outputTokens: 15, reasoningTokens: 5,
    }]);
    expect(parseOpenCode(content, machine)[0]).toMatchObject({
      modelProviderId: "openai", costUsd: 0, loggedCostUsd: null, pricingStatus: "unknown", cacheSavingsUsd: 0.00027,
    });
    expect(parseOpenCode(content.replace('"loggedCostUsd":0', '"loggedCostUsd":-0.01'), machine)[0]).toMatchObject({
      costUsd: 0, loggedCostUsd: null, pricingStatus: "unknown",
    });
  });

  it("keeps unknown models visible without inventing a price", () => {
    const content = [
      { type: "session", id: "s", timestamp: "2026-08-09T00:00:00Z" },
      { type: "message", id: "e", timestamp: "2026-08-09T00:00:01Z", message: { role: "assistant", provider: "custom-local", model: "my-model", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } } },
    ].map(JSON.stringify).join("\n");
    expect(parsePi(content, machine)[0]).toMatchObject({ costUsd: 0, pricingStatus: "unknown", processedTokens: 15 });
  });

  it("estimates cache savings for logged-cost-only records (regression)", () => {
    const content = JSON.stringify([{
      day: "2026-08-09",
      modelProviderId: "opencode-go",
      model: "hy3",
      loggedCostUsd: 0.01,
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheWriteTokens: 1,
      outputTokens: 200,
    }]);
    const record = parseHostUsageAggregates(content, "prime", machine)[0]!;
    expect(record).toMatchObject({ pricingStatus: "logged", loggedCostUsd: 0.01 });
    expect(record.cacheSavingsUsd).toBeGreaterThan(0);
  });

  it("prices host-side aggregates without exposing file metadata", () => {
    const content = JSON.stringify([{
      day: "2026-08-09",
      modelProviderId: "openai",
      model: "gpt-5.6-sol",
      loggedCostUsd: null,
      uncachedInputTokens: 40,
      cachedInputTokens: 60,
      cacheWriteTokens: 5,
      outputTokens: 20,
    }]);
    expect(parseHostUsageAggregates(content, "codex", machine)[0]).toMatchObject({
      eventKey: "codex:machine-a:2026-08-09:openai:gpt-5.6-sol:Unknown",
      agentId: "codex",
      modelProviderId: "openai",
      processedTokens: 125,
    });
    expect(parseHostUsageAggregates(content, "prime", machine)[0]).toMatchObject({
      eventKey: "prime:machine-a:2026-08-09:openai:gpt-5.6-sol:Unknown",
      agentId: "prime",
      agentName: "Prime Agent",
    });
  });

  it("uses FX-recorded spend without replacing it with API-rate estimates", () => {
    const aggregate = (loggedCostUsd: number | null) => JSON.stringify([{
      day: "2026-08-09",
      modelProviderId: "zai",
      model: "zai/glm-5.2",
      loggedCostUsd,
      uncachedInputTokens: 35,
      cachedInputTokens: 60,
      cacheWriteTokens: 5,
      outputTokens: 15,
    }]);
    expect(parseHostUsageAggregates(aggregate(0.015), "fx", machine)[0]).toMatchObject({
      eventKey: "fx:machine-a:2026-08-09:zai:zai%2Fglm-5.2:Unknown",
      agentId: "fx",
      agentName: "FX",
      modelProviderId: "zai",
      model: "zai/glm-5.2",
      processedTokens: 115,
      costUsd: 0.015,
      loggedCostUsd: 0.015,
      pricingStatus: "logged",
      cacheSavingsUsd: 0.000068,
    });
    expect(parseHostUsageAggregates(aggregate(0), "fx", machine)[0]).toMatchObject({
      costUsd: 0,
      loggedCostUsd: 0,
      pricingStatus: "logged",
    });
    expect(parseHostUsageAggregates(aggregate(null), "fx", machine)[0]).toMatchObject({
      costUsd: 0,
      loggedCostUsd: null,
      pricingStatus: "unknown",
    });
  });

  it("parses Antigravity host aggregates with the Antigravity agent name", () => {
    const content = JSON.stringify([{
      day: "2026-08-09",
      modelProviderId: "google",
      model: "gemini-4-ultra-preview",
      project: "Unknown",
      loggedCostUsd: null,
      uncachedInputTokens: 2302,
      cachedInputTokens: 8113,
      cacheWriteTokens: 0,
      outputTokens: 657,
    }]);
    expect(parseHostUsageAggregates(content, "antigravity", machine)[0]).toMatchObject({
      eventKey: "antigravity:machine-a:2026-08-09:google:gemini-4-ultra-preview:Unknown",
      agentId: "antigravity",
      agentName: "Antigravity",
      modelProviderId: "google",
      processedTokens: 11072,
    });
  });
});
