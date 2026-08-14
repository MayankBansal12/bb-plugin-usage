import { generatedAt, providers } from "@opencode-ai/models/snapshot";
import type { ModelCost } from "@opencode-ai/models";

export type Price = { input: number; cached: number; cacheWrite: number; output: number };
export type PricingStatus = "models-dev-exact" | "models-dev-alias" | "logged" | "unknown";
export type PricingResult = {
  modelProviderId: string;
  modelProviderName: string;
  price: Price | null;
  status: Exclude<PricingStatus, "logged">;
};

type CatalogModel = { id: string; cost?: ModelCost };
export type CatalogProvider = { id?: string; name?: string; models: Record<string, CatalogModel> };
const catalog = providers as unknown as Record<string, CatalogProvider>;

let activeCatalog: { revision: string; providers: Record<string, CatalogProvider> } | null = null;

export function setPricingCatalog(providers: Record<string, CatalogProvider>, revision: string) {
  activeCatalog = { revision, providers };
}

export function resetPricingCatalog() {
  activeCatalog = null;
}

function activeProviders() {
  return activeCatalog?.providers ?? catalog;
}

const providerAliases: Record<string, string> = {
  bedrock: "amazon-bedrock",
  vertex: "google-vertex",
  "x-ai": "xai",
  copilot: "github-copilot",
};

export function pricingRevision() {
  return activeCatalog?.revision ?? generatedAt;
}

export function pricingVersion() {
  const revision = pricingRevision();
  return (revision.includes("@") ? revision.slice(revision.indexOf("@") + 1) : revision).slice(0, 10);
}

export function normalizeProviderId(providerId: string) {
  const normalized = providerId.trim().toLowerCase().replace(/_/g, "-");
  return providerAliases[normalized] ?? (normalized || "unknown");
}

function normalizedModelIds(providerId: string, model: string) {
  const normalized = model.trim().toLowerCase();
  const withoutProvider = normalized.startsWith(`${providerId}/`) ? normalized.slice(providerId.length + 1) : normalized;
  return [...new Set([normalized, withoutProvider])];
}

function toPrice(cost: ModelCost): Price | null {
  const input = Number(cost.input);
  const output = Number(cost.output);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  const cached = Number(cost.cache_read ?? input);
  const cacheWrite = Number(cost.cache_write ?? input);
  return {
    input: Math.max(0, input),
    cached: Number.isFinite(cached) ? Math.max(0, cached) : Math.max(0, input),
    cacheWrite: Number.isFinite(cacheWrite) ? Math.max(0, cacheWrite) : Math.max(0, input),
    output: Math.max(0, output),
  };
}

function providerName(providerId: string, provider?: CatalogProvider) {
  return provider?.name?.trim() || providerId.split("-").map((part) => part ? `${part[0]!.toUpperCase()}${part.slice(1)}` : part).join(" ");
}

function matchWithinProvider(providerId: string, provider: CatalogProvider, model: string): PricingResult | null {
  const modelIds = normalizedModelIds(providerId, model);
  for (const modelId of modelIds) {
    const exact = provider.models[modelId];
    const price = exact?.cost ? toPrice(exact.cost) : null;
    if (price) return { modelProviderId: providerId, modelProviderName: providerName(providerId, provider), price, status: "models-dev-exact" };
  }

  const alias = Object.values(provider.models)
    .filter((candidate) => candidate.cost && modelIds.some((modelId) =>
      modelId.startsWith(`${candidate.id.toLowerCase()}-`) || modelId.startsWith(`${candidate.id.toLowerCase()}:`)))
    .sort((a, b) => b.id.length - a.id.length)[0];
  const price = alias?.cost ? toPrice(alias.cost) : null;
  return price ? { modelProviderId: providerId, modelProviderName: providerName(providerId, provider), price, status: "models-dev-alias" } : null;
}

export function resolvePricing(rawProviderId: string, model: string): PricingResult {
  const modelProviderId = normalizeProviderId(rawProviderId);
  const provider = activeProviders()[modelProviderId];
  if (provider) {
    const match = matchWithinProvider(modelProviderId, provider, model);
    if (match) return match;
  }

  const exactMatches = Object.entries(activeProviders()).flatMap(([candidateId, candidate]) => {
    const exact = normalizedModelIds(modelProviderId, model).map((modelId) => candidate.models[modelId]).find((item) => item?.cost);
    const price = exact?.cost ? toPrice(exact.cost) : null;
    return price ? [{ modelProviderId: normalizeProviderId(candidateId), modelProviderName: providerName(candidateId, candidate), price }] : [];
  });
  if (exactMatches.length === 1) return { ...exactMatches[0]!, status: "models-dev-exact" };

  return { modelProviderId, modelProviderName: providerName(modelProviderId, provider), price: null, status: "unknown" };
}

export function priceFor(providerId: string, model: string): Price | null {
  return resolvePricing(providerId, model).price;
}
