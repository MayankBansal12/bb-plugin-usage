import { describe, expect, it } from "vitest";
import { normalizeProviderId, priceFor, resolvePricing, PRICING_VERSION } from "./pricing";

describe("models.dev pricing", () => {
  it("uses provider/model rates from the bundled snapshot", () => {
    expect(priceFor("openai", "gpt-5.6-terra")).toEqual({ input: 2, cached: 0.2, cacheWrite: 2.5, output: 12 });
    expect(priceFor("anthropic", "claude-fable-5")).toEqual({ input: 10, cached: 1, cacheWrite: 12.5, output: 50 });
    expect(priceFor("xai", "grok-4.5")).toEqual({ input: 2, cached: 0.3, cacheWrite: 2, output: 6 });
  });

  it("normalizes provider aliases and dated model suffixes", () => {
    expect(normalizeProviderId("x-ai")).toBe("xai");
    expect(priceFor("anthropic", "claude-sonnet-5-20990101")).toEqual(priceFor("anthropic", "claude-sonnet-5"));
  });

  it("does not assign an unrelated fallback price to unknown models", () => {
    expect(priceFor("custom-local", "unreleased-model")).toBeNull();
    expect(resolvePricing("custom-local", "unreleased-model")).toMatchObject({ status: "unknown", price: null });
  });

  it("derives the displayed version from the bundled snapshot", () => {
    expect(PRICING_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
