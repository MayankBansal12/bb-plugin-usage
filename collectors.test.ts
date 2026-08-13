import { describe, expect, it } from "vitest";
import { parseClaude, parseCodex, parseGrok, parseOpenCode, parsePi } from "./collectors";

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
    expect(record).toMatchObject({ eventKey: "pi:pi-session:entry-1", agentId: "pi", agentName: "Prime Agent", modelProviderId: "google", loggedCostUsd: 0.0012, processedTokens: 125 });
    expect(JSON.stringify(record)).not.toContain("not retained");
  });

  it("parses OpenCode metadata aggregates and rejects malformed output", () => {
    const content = JSON.stringify([{ day: "2026-08-09", modelProviderId: "anthropic", model: "claude-sonnet-5", loggedCostUsd: 0.02, inputTokens: 100, cachedInputTokens: 60, cacheWriteTokens: 5, outputTokens: 15, reasoningTokens: 5 }]);
    expect(parseOpenCode(content, machine)[0]).toMatchObject({
      eventKey: "opencode:machine-a:2026-08-09:anthropic:claude-sonnet-5", agentId: "opencode",
      modelProviderId: "anthropic", processedTokens: 125, outputTokens: 20,
    });
    expect(() => parseOpenCode("not-json", machine)).toThrow("malformed JSON");
  });

  it("keeps unknown models visible without inventing a price", () => {
    const content = [
      { type: "session", id: "s", timestamp: "2026-08-09T00:00:00Z" },
      { type: "message", id: "e", timestamp: "2026-08-09T00:00:01Z", message: { role: "assistant", provider: "custom-local", model: "my-model", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } } },
    ].map(JSON.stringify).join("\n");
    expect(parsePi(content, machine)[0]).toMatchObject({ costUsd: 0, pricingStatus: "unknown", processedTokens: 15 });
  });
});
