import { afterEach, describe, expect, it } from "vitest";
import { normalizeProviderId, priceFor, resetPricingCatalog, resolvePricing, setPricingCatalog, pricingVersion } from "./pricing";

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
    expect(pricingVersion()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("prefers an activated live catalog over the bundled snapshot", () => {
    setPricingCatalog({
      openai: {
        name: "OpenAI",
        models: { "gpt-test-model": { id: "gpt-test-model", cost: { input: 1, output: 2, cache_read: 0.5, cache_write: 1.5 } } },
      },
    }, "models.dev@2026-08-13T00:00:00.000Z");
    expect(priceFor("openai", "gpt-test-model")).toEqual({ input: 1, cached: 0.5, cacheWrite: 1.5, output: 2 });
    expect(pricingVersion()).toBe("2026-08-13");
    resetPricingCatalog();
    expect(priceFor("openai", "gpt-test-model")).toBeNull();
    expect(pricingVersion()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});


afterEach(() => resetPricingCatalog());
it("does not guess variant prices or substitute explicit providers", () => {
  setPricingCatalog({ openai: { models: { base: { id: "base", cost: { input: 2, output: 3 } } } }, reseller: { models: { exclusive: { id: "exclusive", cost: { input: 99, output: 99 } } } } }, "test");
  expect(priceFor("openai", "base-fast")).toBeNull();
  expect(priceFor("openai", "base:premium")).toBeNull();
  expect(priceFor("openai", "base-2026-09-08")).toEqual(priceFor("openai", "base"));
  expect(resolvePricing("openai", "exclusive")).toMatchObject({ modelProviderId: "openai", price: null });
  expect(resolvePricing("custom-gateway", "exclusive")).toMatchObject({ modelProviderId: "reseller", status: "models-dev-alias" });
  expect(resolvePricing("unknown", "exclusive")).toMatchObject({ modelProviderId: "reseller", status: "models-dev-exact" });
});

function catalogProvider(models: Record<string, { input: number; output: number }>, name?: string) {
  return { name, models: Object.fromEntries(Object.entries(models).map(([id, cost]) => [id, { id, cost }])) };
}

const proxyFixture = {
  openai: catalogProvider({ "gpt-5.6-sol": { input: 1, output: 8 } }, "OpenAI"),
  google: catalogProvider({ "gemini-3.8-flash": { input: 0.3, output: 2.5 } }, "Google"),
  deepseek: catalogProvider({ "deepseek-flash": { input: 0.14, output: 0.28 } }, "DeepSeek"),
  xai: catalogProvider({ "grok-4.6": { input: 3, output: 15 } }, "xAI"),
  alibaba: catalogProvider({ "qwen3.8": { input: 1, output: 4 }, "qwen3.8-max": { input: 2.4, output: 9.6 } }, "Alibaba"),
  "kimi-for-coding": catalogProvider({ k3: { input: 0.6, output: 2.5 } }, "Kimi for Coding"),
  "reseller-a": catalogProvider({ "exclusive-model": { input: 9, output: 9 }, "shared-model": { input: 9, output: 9 } }),
  "reseller-b": catalogProvider({ "shared-model": { input: 8, output: 8 } }),
};

describe("proxy provider fallback", () => {
  it("attributes a bare model name to the canonical first-party vendor", () => {
    setPricingCatalog(proxyFixture, "test");
    expect(resolvePricing("cliproxy", "deepseek-flash")).toMatchObject({ modelProviderId: "deepseek", modelProviderName: "DeepSeek", status: "models-dev-alias", price: { input: 0.14, output: 0.28 } });
    expect(resolvePricing("cliproxy", "gemini-3.8-flash")).toMatchObject({ modelProviderId: "google", status: "models-dev-alias" });
    expect(resolvePricing("cliproxy", "grok-4.6")).toMatchObject({ modelProviderId: "xai", status: "models-dev-alias" });
  });

  it("strips effort and promo suffixes only after trying the full name", () => {
    setPricingCatalog(proxyFixture, "test");
    expect(resolvePricing("cliproxy", "gpt-5.6-sol-high")).toMatchObject({ modelProviderId: "openai", status: "models-dev-alias", price: { input: 1, output: 8 } });
    expect(resolvePricing("cliproxy", "deepseek-flash-xhigh")).toMatchObject({ modelProviderId: "deepseek", price: { input: 0.14 } });
    expect(resolvePricing("cliproxy", "k3-expires-on-2026-10-01")).toMatchObject({ modelProviderId: "kimi-for-coding", price: { input: 0.6 } });
    // -max is part of the real model name here, not an effort marker.
    expect(resolvePricing("cliproxy", "qwen3.8-max")).toMatchObject({ modelProviderId: "alibaba", price: { input: 2.4, output: 9.6 } });
  });

  it("falls back to a globally unique match outside first-party vendors", () => {
    setPricingCatalog(proxyFixture, "test");
    expect(resolvePricing("cliproxy", "exclusive-model")).toMatchObject({ modelProviderId: "reseller-a", status: "models-dev-alias" });
    expect(resolvePricing("cliproxy", "exclusive-model-high")).toMatchObject({ modelProviderId: "reseller-a", status: "models-dev-alias" });
  });

  it("stays unknown when catalog-wide matching is ambiguous", () => {
    setPricingCatalog(proxyFixture, "test");
    expect(resolvePricing("cliproxy", "shared-model")).toMatchObject({ modelProviderId: "cliproxy", price: null, status: "unknown" });
    expect(resolvePricing("cliproxy", "shared-model-high")).toMatchObject({ modelProviderId: "cliproxy", price: null, status: "unknown" });
  });

  it("never substitutes another vendor's rates for a catalog provider", () => {
    setPricingCatalog(proxyFixture, "test");
    expect(resolvePricing("openai", "grok-4.6")).toMatchObject({ modelProviderId: "openai", price: null, status: "unknown" });
    expect(resolvePricing("openai", "gpt-5.6-sol-high")).toMatchObject({ modelProviderId: "openai", price: null, status: "unknown" });
  });

  it("leaves models missing from the catalog unpriced", () => {
    setPricingCatalog(proxyFixture, "test");
    for (const model of ["swe-2-max", "codex-auto-review"]) {
      expect(resolvePricing("cliproxy", model)).toMatchObject({ modelProviderId: "cliproxy", price: null, status: "unknown" });
    }
  });

  it("resolves catalog models reported through proxies in the bundled snapshot", () => {
    expect(resolvePricing("cliproxy", "gpt-5.6-terra")).toMatchObject({ modelProviderId: "openai", status: "models-dev-alias", price: { input: 2 } });
    expect(resolvePricing("cliproxy", "gpt-5.6-terra-high")).toMatchObject({ modelProviderId: "openai", status: "models-dev-alias", price: { input: 2 } });
    expect(priceFor("cliproxy", "swe-2-max")).toBeNull();
  });
});
