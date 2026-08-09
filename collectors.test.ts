import { describe, expect, it } from "vitest";
import { parseClaude, parseCodex, parseGrok } from "./collectors";

const firstMachine = { machineId: "machine-a", machineName: "Machine A" };
const secondMachine = { machineId: "machine-b", machineName: "Machine B" };

describe("usage collectors", () => {
  it("parses Codex request usage and creates a machine-independent event key", () => {
    const content = [
      { timestamp: "2026-08-09T00:00:00Z", type: "session_meta", payload: { id: "session-1" } },
      { timestamp: "2026-08-09T00:00:00Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      { timestamp: "2026-08-09T00:00:01Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 5, output_tokens: 20 } } } },
    ].map((row) => JSON.stringify(row)).join("\n");

    const a = parseCodex(content, firstMachine);
    const b = parseCodex(content, secondMachine);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ model: "gpt-5.6-sol", processedTokens: 125, cachedInputTokens: 60, uncachedInputTokens: 40 });
    expect(a[0]!.eventKey).toBe(b[0]!.eventKey);
  });

  it("parses Claude cache reads and writes without message content", () => {
    const content = JSON.stringify({
      type: "assistant", timestamp: "2026-08-09T00:00:00Z",
      message: { id: "message-1", model: "claude-sonnet-5", content: "must not be retained", usage: { input_tokens: 40, cache_read_input_tokens: 60, cache_creation_input_tokens: 5, output_tokens: 20 } },
    });
    const [record] = parseClaude(content, firstMachine);
    expect(record).toMatchObject({ eventKey: "claude:message-1", processedTokens: 125, cacheWriteTokens: 5 });
    expect(JSON.stringify(record)).not.toContain("must not be retained");
  });

  it("parses Grok unified-log inference metadata and ignores malformed tail data", () => {
    const content = `${JSON.stringify({
      ts: "2026-08-09T00:00:00Z", sid: "session-2", msg: "shell.turn.inference_done",
      ctx: { loop_index: 3, prompt_tokens: 100, cached_prompt_tokens: 60, completion_tokens: 15, reasoning_tokens: 5 },
    })}\n{"incomplete"`;
    const [record] = parseGrok(content, firstMachine);
    expect(record).toMatchObject({ eventKey: "grok:session-2:2026-08-09T00:00:00Z:3", processedTokens: 120, outputTokens: 20 });
  });
});
