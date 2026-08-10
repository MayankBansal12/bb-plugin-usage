import { describe, expect, it } from "vitest";
import { priceFor, PRICING_VERSION } from "./pricing";

describe("models.dev pricing", () => {
  it("uses first-party standard token rates from the bundled snapshot", () => {
    expect(priceFor("codex", "gpt-5.6-terra")).toEqual({ input: 2, cached: 0.2, cacheWrite: 2.5, output: 12 });
    expect(priceFor("claude", "claude-fable-5")).toEqual({ input: 10, cached: 1, cacheWrite: 12.5, output: 50 });
    expect(priceFor("grok", "grok-4.5")).toEqual({ input: 2, cached: 0.3, cacheWrite: 2, output: 6 });
  });

  it("normalizes provider prefixes and unknown model suffixes", () => {
    expect(priceFor("codex", "openai/gpt-5.6-luna")).toEqual(priceFor("codex", "gpt-5.6-luna"));
    expect(priceFor("claude", "claude-sonnet-5-20990101")).toEqual(priceFor("claude", "claude-sonnet-5"));
  });

  it("uses a provider fallback model when a log contains an unknown model", () => {
    expect(priceFor("grok", "grok-unreleased")).toEqual(priceFor("grok", "grok-build-0.1"));
  });

  it("derives the displayed version from the bundled snapshot", () => {
    expect(PRICING_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
