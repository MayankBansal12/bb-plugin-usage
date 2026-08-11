export type ProviderLimitWindow = {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  cost?: {
    usedUsdCents: number;
    limitUsdCents: number;
  };
};

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
