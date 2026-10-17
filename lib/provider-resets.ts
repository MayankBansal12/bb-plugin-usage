import type { UnifiedProviderLimit } from "./provider-limits";

export type ProviderResetCredits = {
  availableCount: number;
  // null means the provider reported a count without individual expiry details.
  credits: Array<{ expiresAt?: string | null }> | null;
};

const USAGE_URLS: Record<string, string> = {
  codex: "https://chatgpt.com/codex/settings/usage",
  claude: "https://claude.ai/settings/usage",
};

function remainingCredits(summary: ProviderResetCredits, now: number) {
  const expired = summary.credits?.filter((credit) => credit.expiresAt
    && Date.parse(credit.expiresAt) <= now).length ?? 0;
  return Math.max(0, summary.availableCount - expired);
}

export function resetCreditExpiry(summary: ProviderResetCredits, now = Date.now()) {
  const count = remainingCredits(summary, now);
  if (!count) return null;
  const credits = summary.credits?.filter((credit) => !credit.expiresAt || Date.parse(credit.expiresAt) > now);
  const expiries = credits?.flatMap((credit) => credit.expiresAt ? [credit.expiresAt] : [])
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const expiresAt = expiries?.[0] ?? null;
  const incomplete = !credits || credits.length < count || credits.some((credit) => credit.expiresAt === undefined);
  if (!expiresAt) return { count, label: incomplete ? "Expiry unavailable" : "No expiry", expiresAt: null };
  const minutes = Math.max(1, Math.ceil((Date.parse(expiresAt) - now) / 60_000));
  const duration = minutes < 60 ? `${minutes}m`
    : minutes < 1440 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`
      : `${Math.ceil(minutes / 1440)}d`;
  return { count, label: `${incomplete ? "Known reset expires" : count > 1 ? "Next expires" : "Expires"} in ${duration}`, expiresAt };
}

export function providerResetAction(limit: UnifiedProviderLimit, now = Date.now()) {
  const href = USAGE_URLS[limit.providerId];
  if (!href || limit.status !== "ok" || limit.error || limit.poolAccount?.status === "disabled") return null;
  // A known empty balance has no reset to redeem. Unknown availability still
  // gets a route to the provider's options, without claiming an offer exists.
  if (limit.resetCredits && !remainingCredits(limit.resetCredits, now)) return null;
  const low = limit.windows.some((window) => {
    const label = window.label.trim().toLowerCase();
    const eligible = /^(?:5 hours?|5h|current session|weekly(?: limit)?(?: \([^)]+\))?|7 days)$/.test(label);
    const resetMs = window.resetsAt ? Date.parse(window.resetsAt) : null;
    return eligible && !window.cost && Number.isFinite(window.usedPercent) && window.usedPercent > 80
      && (resetMs === null || (Number.isFinite(resetMs) && resetMs > now));
  });
  if (!low) return null;
  return { href, label: limit.resetCredits ? "Reset usage" : "Reset options" };
}
