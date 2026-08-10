import { generatedAt, providers } from "@opencode-ai/models/snapshot";
import type { ModelCost } from "@opencode-ai/models";

export type PricingProviderId = "codex" | "claude" | "grok";
export type Price = { input: number; cached: number; cacheWrite: number; output: number };

const providerIds: Record<PricingProviderId, "openai" | "anthropic" | "xai"> = {
  codex: "openai",
  claude: "anthropic",
  grok: "xai",
};

const fallbackModelIds: Record<PricingProviderId, string> = {
  codex: "gpt-5.1",
  claude: "claude-opus-4-8",
  grok: "grok-build-0.1",
};

export const PRICING_REVISION = generatedAt;
export const PRICING_VERSION = generatedAt.slice(0, 10);

function normalizedModelId(model: string) {
  return model.trim().toLowerCase().replace(/^(?:openai|anthropic|xai|x-ai)\//, "");
}

function pricedCost(providerId: PricingProviderId, model: string): ModelCost {
  const provider = providers[providerIds[providerId]];
  if (!provider) throw new Error(`models.dev snapshot is missing ${providerIds[providerId]}`);

  const modelId = normalizedModelId(model);
  const exact = provider.models[modelId];
  if (exact?.cost) return exact.cost;

  const alias = Object.values(provider.models)
    .filter((candidate) => candidate.cost && (modelId.startsWith(`${candidate.id}-`) || modelId.startsWith(`${candidate.id}:`)))
    .sort((a, b) => b.id.length - a.id.length)[0];
  if (alias?.cost) return alias.cost;

  const fallback = provider.models[fallbackModelIds[providerId]];
  if (!fallback?.cost) throw new Error(`models.dev snapshot is missing fallback pricing for ${providerId}`);
  return fallback.cost;
}

function toPrice(cost: ModelCost): Price {
  return {
    input: cost.input,
    cached: cost.cache_read ?? cost.input,
    cacheWrite: cost.cache_write ?? cost.input,
    output: cost.output,
  };
}

export function priceFor(providerId: PricingProviderId, model: string): Price {
  return toPrice(pricedCost(providerId, model));
}
