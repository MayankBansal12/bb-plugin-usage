import { afterEach, describe, expect, it } from "vitest";
import { parseClaude, parseCodex, parseGrok, parseHostUsageAggregates, parseOpenCode, parsePi, parsePrime } from "./collectors";

import { resetPricingCatalog, setPricingCatalog } from "./lib/pricing";

afterEach(() => resetPricingCatalog());

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

  it("groups Pi Codex usage under OpenAI while retaining its agent and logged cost", () => {
    const content = JSON.stringify({ type: "message", id: "codex-entry", timestamp: "2026-08-09T00:00:01Z", message: {
      role: "assistant", provider: "openai-codex", model: "gpt-5.6-terra",
      usage: { input: 40, output: 20, cost: { total: 0.0012 } },
    } });
    expect(parsePi(content, machine)[0]).toMatchObject({
      agentId: "pi", modelProviderId: "openai", modelProviderName: "OpenAI",
      costUsd: 0.0012, loggedCostUsd: 0.0012, pricingStatus: "logged", processedTokens: 60,
    });
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
      eventKey: "opencode:machine-a:2026-08-09:anthropic:claude-sonnet-5:logged", agentId: "opencode",
      modelProviderId: "anthropic", processedTokens: 185, cachedInputTokens: 60, uncachedInputTokens: 100,
      outputTokens: 20, costUsd: 0.02, loggedCostUsd: 0.02, pricingStatus: "logged", cacheSavingsUsd: 0.000108,
    });
    expect(() => parseOpenCode("not-json", machine)).toThrow("malformed JSON");
    expect(() => parseOpenCode(JSON.stringify([{}]), machine)).toThrow("invalid aggregate row at index 0");
    expect(() => parseOpenCode(JSON.stringify([{ day: "2026-08-09" }]), machine)).toThrow("invalid aggregate row at index 0");
    expect(parseOpenCode("[]", machine)).toEqual([]);
  });

  it("estimates OpenCode cost when the agent did not record a positive cost", () => {
    const content = JSON.stringify([{
      day: "2026-08-09", modelProviderId: "openai", model: "gpt-5.6-sol", loggedCostUsd: 0,
      inputTokens: 100, cachedInputTokens: 60, cacheWriteTokens: 5, outputTokens: 15, reasoningTokens: 5,
    }]);
    expect(parseOpenCode(content, machine)[0]).toMatchObject({
      modelProviderId: "openai", costUsd: 0.001161, loggedCostUsd: null, pricingStatus: "models-dev-exact", cacheSavingsUsd: 0.00027,
    });
    expect(parseOpenCode(content.replace('"loggedCostUsd":0', '"loggedCostUsd":-0.01'), machine)[0]).toMatchObject({
      costUsd: 0.001161, loggedCostUsd: null, pricingStatus: "models-dev-exact",
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
      day: "2026-08-09",
      agentId: "codex",
      modelProviderId: "openai",
      processedTokens: 125,
    });
    expect(parseHostUsageAggregates(content, "prime", machine)[0]).toMatchObject({
      eventKey: "prime:machine-a:2026-08-09:openai:gpt-5.6-sol:Unknown:estimate",
      agentId: "prime",
      agentName: "Prime Agent",
    });
  });

  it("parses Devin host aggregates with the Devin agent and provider", () => {
    const content = JSON.stringify([{
      day: "2026-08-09",
      modelProviderId: "devin",
      model: "swe-2-max",
      project: "project-a",
      loggedCostUsd: null,
      uncachedInputTokens: 150,
      cachedInputTokens: 60,
      cacheWriteTokens: 5,
      outputTokens: 30,
    }]);
    expect(parseHostUsageAggregates(content, "devin", machine)[0]).toMatchObject({
      eventKey: "devin:machine-a:2026-08-09:devin:swe-2-max:project-a",
      agentId: "devin",
      agentName: "Devin",
      modelProviderId: "devin",
      modelProviderName: "Devin",
      processedTokens: 245,
      // SWE models are not listed on models.dev, so cost stays unknown rather
      // than borrowing another vendor's rates.
      costUsd: 0,
      pricingStatus: "unknown",
    });
  });

  it("attributes host-scanned Codex profile rows to their own agent", () => {
    const row = (account: string | undefined) => ({
      day: "2026-08-09",
      modelProviderId: "openai",
      model: "gpt-5.6-sol",
      project: "app",
      ...(account === undefined ? {} : { account }),
      loggedCostUsd: null,
      uncachedInputTokens: 40,
      cachedInputTokens: 60,
      cacheWriteTokens: 5,
      outputTokens: 20,
    });
    const records = parseHostUsageAggregates(JSON.stringify([row("saiens"), row("omnidrome"), row(undefined)]), "codex", machine);
    expect(records).toHaveLength(3);
    expect(new Set(records.map((record) => record.eventKey)).size).toBe(3);
    expect(records[0]).toMatchObject({
      eventKey: "codex-saiens:machine-a:2026-08-09:openai:gpt-5.6-sol:app",
      agentId: "codex-saiens",
      agentName: "Codex (saiens)",
      modelProviderId: "openai",
    });
    expect(records[1]).toMatchObject({ agentId: "codex-omnidrome", agentName: "Codex (omnidrome)" });
    expect(records[2]).toMatchObject({
      eventKey: "codex:machine-a:2026-08-09:openai:gpt-5.6-sol:app",
      agentId: "codex",
      agentName: "Codex",
    });
  });

  it("ignores account labels on non-Codex scans", () => {
    const content = JSON.stringify([{
      day: "2026-08-09",
      modelProviderId: "anthropic",
      model: "claude-sonnet-5",
      account: "saiens",
      loggedCostUsd: null,
      uncachedInputTokens: 40,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 10,
    }]);
    expect(parseHostUsageAggregates(content, "claude", machine)[0]).toMatchObject({
      eventKey: "claude:machine-a:2026-08-09:anthropic:claude-sonnet-5:Unknown",
      agentId: "claude",
      agentName: "Claude Code",
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

  it("parses Thaura host aggregates and estimates cost from the pinned rate", () => {
    const content = JSON.stringify([{
      day: "2026-08-09",
      modelProviderId: "thaura",
      model: "thaura",
      project: "Unknown",
      loggedCostUsd: null,
      uncachedInputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000_000,
    }]);
    expect(parseHostUsageAggregates(content, "thaura", machine)[0]).toMatchObject({
      eventKey: "thaura:machine-a:2026-08-09:thaura:thaura:Unknown:estimate",
      agentId: "thaura",
      agentName: "Thaura",
      modelProviderId: "thaura",
      modelProviderName: "Thaura",
      costUsd: 2.5,
      pricingStatus: "models-dev-exact",
      processedTokens: 2_000_000,
    });
  });

  it("prefers Thaura's recorded cost over the estimate and keeps mixed days separate", () => {
    const day = "2026-08-09";
    const logged = JSON.stringify([{
      day, modelProviderId: "thaura", model: "thaura", project: "Unknown",
      loggedCostUsd: 7, uncachedInputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000_000,
    }]);
    expect(parseHostUsageAggregates(logged, "thaura", machine)[0]).toMatchObject({
      eventKey: `thaura:machine-a:${day}:thaura:thaura:Unknown:logged`,
      costUsd: 7,
      loggedCostUsd: 7,
      pricingStatus: "logged",
    });

    // One $7 recorded request plus one ~$2.50 estimated request on the same day
    // must total $9.50, not blend into a single blended row.
    const mixed = JSON.stringify([
      { day, modelProviderId: "thaura", model: "thaura", project: "Unknown",
        loggedCostUsd: 7, uncachedInputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000_000 },
      { day, modelProviderId: "thaura", model: "thaura", project: "Unknown",
        loggedCostUsd: null, uncachedInputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000_000 },
    ]);
    const records = parseHostUsageAggregates(mixed, "thaura", machine);
    expect(records).toHaveLength(2);
    expect(records.reduce((sum, record) => sum + record.costUsd, 0)).toBeCloseTo(9.5);
    expect(records.find((record) => record.pricingStatus === "logged")?.costUsd).toBe(7);
    expect(records.find((record) => record.pricingStatus !== "logged")?.costUsd).toBeCloseTo(2.5);
  });
});


describe("agent cost fallback", () => {
  const setup = () => setPricingCatalog({ openai: { name: "OpenAI", models: {
    "gpt-6-astra": { id: "gpt-6-astra", cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 } },
    "gpt-5.6-luna": { id: "gpt-5.6-luna", cost: { input: 0.2, output: 1.2, cache_read: 0.02, cache_write: 0.25 } },
  } } }, "test");

  it.each(["gpt-6-astra", "gpt-5.6-luna"])("prices OpenCode %s token buckets", (model) => {
    setup();
    const row = { day: "2026-08-09", modelProviderId: "openai", model, loggedCostUsd: 0,
      inputTokens: 1000000, cachedInputTokens: 1000000, cacheWriteTokens: 1000000, outputTokens: 800000, reasoningTokens: 200000 };
    expect(parseOpenCode(JSON.stringify([row]), machine)[0]).toMatchObject({
      costUsd: model === "gpt-6-astra" ? 73.5 : 1.67, pricingStatus: "models-dev-exact", processedTokens: 4000000,
    });
    expect(parseOpenCode(JSON.stringify([{ ...row, loggedCostUsd: 7 }]), machine)[0]).toMatchObject({ costUsd: 7, pricingStatus: "logged" });
    expect(parseOpenCode(JSON.stringify([{ ...row, model: "unlisted" }]), machine)[0]).toMatchObject({ costUsd: 0, pricingStatus: "unknown" });
  });

  it.each([0, null, -1])("estimates Pi and Prime with recorded cost %s, including host aggregates", (loggedCostUsd) => {
    setup();
    const content = JSON.stringify({ type: "message", id: "entry", timestamp: "2026-08-09T00:00:01Z", message: {
      role: "assistant", provider: "openai-codex", model: "gpt-6-astra",
      usage: { input: 1000000, cacheRead: 1000000, cacheWrite: 1000000, output: 1000000, cost: { total: loggedCostUsd } },
    } });
    for (const parser of [parsePi, parsePrime]) expect(parser(content, machine)[0]).toMatchObject({ costUsd: 73.5, pricingStatus: "models-dev-exact", modelProviderId: "openai" });
    for (const agent of ["pi", "prime"] as const) {
      const row = { day: "2026-08-09", modelProviderId: "openai-codex", model: "gpt-6-astra", loggedCostUsd,
        uncachedInputTokens: 1000000, cachedInputTokens: 1000000, cacheWriteTokens: 1000000, outputTokens: 1000000 };
      expect(parseHostUsageAggregates(JSON.stringify([row]), agent, machine)[0]).toMatchObject({ costUsd: 73.5, pricingStatus: "models-dev-exact" });
      expect(parseHostUsageAggregates(JSON.stringify([{ ...row, loggedCostUsd: 7 }]), agent, machine)[0]).toMatchObject({ costUsd: 7, pricingStatus: "logged" });
    }
  });
});
