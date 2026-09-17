export type CacheUsageRecord = {
  agentId: string;
  agentName: string;
  model: string;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  uncachedInputTokens: number;
};

export type CacheHitRateGroup = {
  key: string;
  agentId: string;
  agentName: string;
  model: string | null;
  cachedInputTokens: number;
  totalInputTokens: number;
  rate: number | null;
};

const CACHE_REPORTING_AGENTS = new Set([
  "amp",
  "antigravity",
  "claude",
  "codebuddy",
  "codex",
  "copilot",
  "cursor",
  "devin",
  "dsh",
  "fx",
  "grok",
  "opencode",
  "pi",
  "prime",
  "thaura",
]);

export function reportsCacheUsage(agentId: string) {
  return CACHE_REPORTING_AGENTS.has(agentId) || agentId.startsWith("codex-");
}

export function cacheHitRateGroups(records: CacheUsageRecord[], groupBy: "agent" | "model"): CacheHitRateGroup[] {
  const groups = new Map<string, Omit<CacheHitRateGroup, "rate" | "totalInputTokens"> & { cacheWriteTokens: number; uncachedInputTokens: number }>();
  for (const record of records) {
    const key = groupBy === "agent" ? record.agentId : `${record.agentId}\0${record.model}`;
    const current = groups.get(key) ?? {
      key,
      agentId: record.agentId,
      agentName: record.agentName,
      model: groupBy === "model" ? record.model : null,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      uncachedInputTokens: 0,
    };
    current.cachedInputTokens += record.cachedInputTokens;
    current.cacheWriteTokens += record.cacheWriteTokens;
    current.uncachedInputTokens += record.uncachedInputTokens;
    groups.set(key, current);
  }

  return [...groups.values()].map((group) => {
    const totalInputTokens = group.cachedInputTokens + group.cacheWriteTokens + group.uncachedInputTokens;
    return {
      key: group.key,
      agentId: group.agentId,
      agentName: group.agentName,
      model: group.model,
      cachedInputTokens: group.cachedInputTokens,
      totalInputTokens,
      rate: reportsCacheUsage(group.agentId) && totalInputTokens > 0
        ? group.cachedInputTokens / totalInputTokens
        : null,
    };
  }).sort((a, b) => {
    if (a.rate === null) return b.rate === null ? a.key.localeCompare(b.key) : 1;
    if (b.rate === null) return -1;
    return b.rate - a.rate || b.totalInputTokens - a.totalInputTokens || a.key.localeCompare(b.key);
  });
}
