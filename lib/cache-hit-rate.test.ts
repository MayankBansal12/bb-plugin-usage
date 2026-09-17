import { describe, expect, it } from "vitest";
import { cacheHitRateGroups, reportsCacheUsage } from "./cache-hit-rate";

describe("cache hit rate groups", () => {
  it("calculates a token-weighted agent rate instead of averaging row percentages", () => {
    const groups = cacheHitRateGroups([
      { agentId: "amp", agentName: "Amp", model: "large", cachedInputTokens: 90, cacheWriteTokens: 5, uncachedInputTokens: 5 },
      { agentId: "amp", agentName: "Amp", model: "small", cachedInputTokens: 0, cacheWriteTokens: 5, uncachedInputTokens: 5 },
    ], "agent");

    expect(groups).toEqual([expect.objectContaining({
      agentId: "amp",
      cachedInputTokens: 90,
      totalInputTokens: 110,
      rate: 90 / 110,
    })]);
  });

  it("keeps the same model separate when it is used by different agents", () => {
    const groups = cacheHitRateGroups([
      { agentId: "amp", agentName: "Amp", model: "gpt", cachedInputTokens: 60, cacheWriteTokens: 10, uncachedInputTokens: 30 },
      { agentId: "codex", agentName: "Codex", model: "gpt", cachedInputTokens: 10, cacheWriteTokens: 0, uncachedInputTokens: 90 },
    ], "model");

    expect(groups.map((group) => [group.agentId, group.model, group.rate])).toEqual([
      ["amp", "gpt", 0.6],
      ["codex", "gpt", 0.1],
    ]);
  });

  it("reports unknown for unsupported agents and rows without input", () => {
    const groups = cacheHitRateGroups([
      { agentId: "future", agentName: "Future", model: "model", cachedInputTokens: 5, cacheWriteTokens: 0, uncachedInputTokens: 5 },
      { agentId: "amp", agentName: "Amp", model: "output-only", cachedInputTokens: 0, cacheWriteTokens: 0, uncachedInputTokens: 0 },
    ], "agent");

    expect(groups.every((group) => group.rate === null)).toBe(true);
    expect(reportsCacheUsage("codex-work")).toBe(true);
    expect(reportsCacheUsage("future")).toBe(false);
  });
});
