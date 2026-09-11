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
  "openai-codex": "openai",
  bedrock: "amazon-bedrock",
  vertex: "google-vertex",
  "x-ai": "xai",
  copilot: "github-copilot",
};

// Providers not listed on models.dev get their published rates pinned here so
// usage still prices before (or without) a catalog entry.
const builtinPrices: Record<string, { name?: string; models: Record<string, Price> }> = {
  thaura: {
    name: "Thaura",
    models: { thaura: { input: 0.5, cached: 0.5, cacheWrite: 0.5, output: 2 } },
  },
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
      modelId.startsWith(`${candidate.id.toLowerCase()}-`) && /^-(?:\d{8}|\d{4}-\d{2}-\d{2})$/.test(modelId.slice(candidate.id.length))))
    .sort((a, b) => b.id.length - a.id.length)[0];
  const price = alias?.cost ? toPrice(alias.cost) : null;
  return price ? { modelProviderId: providerId, modelProviderName: providerName(providerId, provider), price, status: "models-dev-alias" } : null;
}

// First-party vendors tried in order for rows whose provider is missing from
// the catalog — typically a proxy gateway such as cliproxy reporting bare model
// names. The first vendor pricing a model variant wins, so canonical vendors
// outrank reseller mirrors of the same model.
const firstPartyProviders = [
  "openai", "anthropic", "google", "google-vertex", "deepseek", "xai",
  "zai", "zhipuai", "alibaba", "meta", "kimi-for-coding", "moonshotai",
  "mistral", "minimax",
];

// Gateways decorate catalog model names with routing hints: promo tags
// (-expires-on-…) and reasoning effort (-low/-medium/-high/-xhigh/-max). -max
// is also part of real model names (qwen3.8-max), so variants are always tried
// from most to least specific.
const proxyDecorationPatterns = [/-expires-on-.+$/, /-(?:low|medium|high|xhigh|max)$/];

function proxyModelIds(providerId: string, model: string) {
  const seen = new Set<string>();
  const modelIds: string[] = [];
  const queue = normalizedModelIds(providerId, model);
  while (queue.length > 0) {
    const candidate = queue.shift()!;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    modelIds.push(candidate);
    for (const pattern of proxyDecorationPatterns) {
      const stripped = candidate.replace(pattern, "");
      if (stripped && stripped !== candidate) queue.push(stripped);
    }
  }
  return modelIds;
}

function matchViaFirstParty(modelIds: string[]): PricingResult | null {
  const providers = activeProviders();
  for (const vendorId of firstPartyProviders) {
    const vendor = providers[vendorId];
    if (!vendor) continue;
    for (const modelId of modelIds) {
      const match = matchWithinProvider(vendorId, vendor, modelId);
      // Attribution is inferred rather than reported, hence alias status.
      if (match) return { ...match, status: "models-dev-alias" };
    }
  }
  return null;
}

function uniqueCatalogMatch(modelIds: string[]): PricingResult | null {
  for (const modelId of modelIds) {
    const matches = Object.entries(activeProviders()).flatMap(([candidateId, candidate]) => {
      const price = candidate.models[modelId]?.cost ? toPrice(candidate.models[modelId]!.cost!) : null;
      return price ? [{ modelProviderId: normalizeProviderId(candidateId), modelProviderName: providerName(candidateId, candidate), price }] : [];
    });
    // Only a globally unique hit resolves; an ambiguous variant stops the walk
    // so a less specific name cannot silently price a different model.
    if (matches.length > 0) return matches.length === 1 ? { ...matches[0]!, status: "models-dev-alias" } : null;
  }
  return null;
}

export function resolvePricing(rawProviderId: string, model: string): PricingResult {
  const modelProviderId = normalizeProviderId(rawProviderId);
  const provider = activeProviders()[modelProviderId];
  if (provider) {
    const match = matchWithinProvider(modelProviderId, provider, model);
    if (match) return match;
  }

  const builtin = builtinPrices[modelProviderId]?.models[model.trim().toLowerCase()];
  if (builtin) {
    return { modelProviderId, modelProviderName: providerName(modelProviderId, provider) || builtinPrices[modelProviderId]!.name!, price: builtin, status: "models-dev-exact" };
  }

  // Explicit providers must never inherit a different vendor's rates.
  if (provider || builtinPrices[modelProviderId]) {
    return { modelProviderId, modelProviderName: providerName(modelProviderId, provider), price: null, status: "unknown" };
  }

  // Catalog-less providers (proxy gateways like cliproxy) can still resolve to
  // the vendor actually serving the model: first-party vendors over decorated
  // name variants, then a catalog-wide unique exact match.
  if (modelProviderId !== "unknown") {
    const modelIds = proxyModelIds(modelProviderId, model);
    const inferred = matchViaFirstParty(modelIds) ?? uniqueCatalogMatch(modelIds);
    return inferred ?? { modelProviderId, modelProviderName: providerName(modelProviderId, provider), price: null, status: "unknown" };
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
