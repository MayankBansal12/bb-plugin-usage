export type ProviderLimitWindow = {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  cost?: {
    usedUsdCents: number;
    limitUsdCents: number;
  };
};

export type ProviderLimitSource = {
  machineId: string;
  machineName: string;
  agentId: string;
  agentName: string;
  providerId: string;
  providerName: string;
  accountEmail: string | null;
  planLabel: string | null;
  windows: ProviderLimitWindow[];
  status: "ok" | "error";
  error: string | null;
  lastUpdatedAt: string | null;
};

export type UnifiedProviderLimit = {
  id: string;
  providerId: string;
  providerName: string;
  accountEmail: string | null;
  planLabel: string | null;
  windows: ProviderLimitWindow[];
  status: "ok" | "error";
  error: string | null;
  lastUpdatedAt: string | null;
  machines: Array<{
    machineId: string;
    machineName: string;
    agents: Array<{ id: string; name: string }>;
    windows: ProviderLimitWindow[];
    status: "ok" | "error";
    error: string | null;
    lastUpdatedAt: string | null;
  }>;
};

function normalizedIdentity(value: string | null) {
  return value?.trim().toLocaleLowerCase() || null;
}

function subscriptionId(source: ProviderLimitSource) {
  const account = normalizedIdentity(source.accountEmail);
  return `${source.providerId}\0${account ? `account:${account}` : `machine:${source.machineId}`}`;
}

function latestTimestamp(values: Array<string | null>) {
  return values.filter((value): value is string => value !== null)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

function combinedError(sources: ProviderLimitSource[]) {
  const errors = [...new Set(sources.map((source) => source.error).filter((error): error is string => Boolean(error)))];
  return errors.length > 0 ? errors.join("; ") : null;
}

export function mergeLimitWindows(sources: ProviderLimitSource[]) {
  const order: string[] = [];
  const windows = new Map<string, ProviderLimitWindow>();
  for (const source of sources) {
    for (const window of source.windows) {
      const key = window.label.trim().toLocaleLowerCase();
      const current = windows.get(key);
      if (!current) {
        order.push(key);
        windows.set(key, window.cost
          ? { label: window.label, usedPercent: window.usedPercent, resetsAt: window.resetsAt, cost: { ...window.cost } }
          : { label: window.label, usedPercent: window.usedPercent, resetsAt: window.resetsAt });
        continue;
      }
      const currentReset = current.resetsAt ? Date.parse(current.resetsAt) : Number.NaN;
      const nextReset = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
      const nextIsNewerCycle = Number.isFinite(nextReset)
        && (!Number.isFinite(currentReset) || nextReset > currentReset);
      const sameCycle = current.resetsAt === window.resetsAt
        || (!Number.isFinite(currentReset) && !Number.isFinite(nextReset));
      if (nextIsNewerCycle || (sameCycle && window.usedPercent > current.usedPercent)) {
        windows.set(key, window.cost
          ? { label: window.label, usedPercent: window.usedPercent, resetsAt: window.resetsAt, cost: { ...window.cost } }
          : { label: window.label, usedPercent: window.usedPercent, resetsAt: window.resetsAt });
      }
    }
  }
  return order.map((key) => windows.get(key)!);
}

export function groupProviderLimits(sources: ProviderLimitSource[]): UnifiedProviderLimit[] {
  const subscriptions = new Map<string, ProviderLimitSource[]>();
  for (const source of sources) {
    const id = subscriptionId(source);
    const group = subscriptions.get(id) ?? [];
    group.push(source);
    subscriptions.set(id, group);
  }

  return Array.from(subscriptions, ([id, group]) => {
    const machineGroups = new Map<string, ProviderLimitSource[]>();
    for (const source of group) {
      const machineGroup = machineGroups.get(source.machineId) ?? [];
      machineGroup.push(source);
      machineGroups.set(source.machineId, machineGroup);
    }
    const machines = Array.from(machineGroups, ([machineId, machineSources]) => ({
      machineId,
      machineName: machineSources[0]?.machineName ?? "Unknown machine",
      agents: Array.from(
        new Map(machineSources.map((source) => [source.agentId, { id: source.agentId, name: source.agentName }])).values(),
      ),
      windows: mergeLimitWindows(machineSources),
      status: machineSources.some((source) => source.status === "ok") ? "ok" as const : "error" as const,
      error: combinedError(machineSources),
      lastUpdatedAt: latestTimestamp(machineSources.map((source) => source.lastUpdatedAt)),
    })).sort((left, right) => left.machineName.localeCompare(right.machineName));
    const status = group.some((source) => source.status === "ok") ? "ok" as const : "error" as const;
    return {
      id,
      providerId: group[0]!.providerId,
      providerName: group[0]!.providerName,
      accountEmail: group.find((source) => source.accountEmail)?.accountEmail ?? null,
      planLabel: group.find((source) => source.planLabel)?.planLabel ?? null,
      windows: mergeLimitWindows(group),
      status,
      error: combinedError(group),
      lastUpdatedAt: latestTimestamp(group.map((source) => source.lastUpdatedAt)),
      machines,
    };
  }).sort((left, right) => left.providerName.localeCompare(right.providerName)
    || (left.accountEmail ?? left.planLabel ?? "").localeCompare(right.accountEmail ?? right.planLabel ?? ""));
}

export function clampPercent(value: number) {
  return Math.min(100, Math.max(0, value));
}

export function formatLimitReset(resetsAt: string | null, nowMs = Date.now()) {
  if (!resetsAt) return null;
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return null;

  const remainingMinutes = Math.ceil((resetMs - nowMs) / 60_000);
  if (remainingMinutes <= 0) return "Reset due";
  if (remainingMinutes < 60) return `Resets in ${remainingMinutes}m`;
  if (remainingMinutes < 24 * 60) {
    const hours = Math.floor(remainingMinutes / 60);
    const minutes = remainingMinutes % 60;
    return `Resets in ${hours}h${minutes ? ` ${minutes}m` : ""}`;
  }
  return `Resets in ${Math.ceil(remainingMinutes / (24 * 60))}d`;
}

export function formatLimitValue(window: ProviderLimitWindow) {
  if (window.cost) {
    return `$${(window.cost.usedUsdCents / 100).toFixed(2)} of $${(window.cost.limitUsdCents / 100).toFixed(2)}`;
  }
  return `${Math.round(clampPercent(window.usedPercent))}% used`;
}
