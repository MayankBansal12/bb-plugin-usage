import type { BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { mergeLimitWindows, type ProviderLimitWindow, type UnifiedProviderLimit } from "./provider-limits";

const quotaSchema = z.object({
  utilization: z.number().nullable(),
  resetAt: z.number().nullable(),
});

export const poolAccountsSchema = z.array(z.object({
  id: z.string().min(1),
  provider: z.string(),
  kind: z.enum(["oauth", "api-key"]),
  label: z.string().min(1),
  email: z.string().nullable(),
  subscriptionType: z.string().nullable(),
  enabled: z.boolean(),
  status: z.string(),
  error: z.string().nullable(),
  observedAt: z.number().nullable(),
  fiveHourUtilization: z.number().nullable(),
  fiveHourResetAt: z.number().nullable(),
  sevenDayUtilization: z.number().nullable(),
  sevenDayResetAt: z.number().nullable(),
  familyWeekly: z.record(z.string(), quotaSchema.nullable()),
  limitWindows: z.array(quotaSchema.extend({
    slot: z.string(),
    windowMinutes: z.number().positive().nullable(),
    status: z.string().nullable(),
  })),
}));

type PoolAccount = z.infer<typeof poolAccountsSchema>[number];

function timestamp(value: number | null) {
  return value !== null && value > 0 && value <= 8.64e15 ? new Date(value).toISOString() : null;
}

function windowLabel(minutes: number | null, slot: string) {
  if (minutes === null) return slot === "primary" ? "Primary window" : "Secondary window";
  if (minutes === 10080) return "Weekly";
  if (minutes % 1440 === 0) return `${minutes / 1440} days`;
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

function accountWindows(account: PoolAccount) {
  const windows: ProviderLimitWindow[] = [];
  const add = (label: string, utilization: number | null, resetAt: number | null) => {
    if (utilization === null) return;
    windows.push({ label, usedPercent: utilization * 100, resetsAt: timestamp(resetAt) });
  };
  if (account.provider === "codex") {
    for (const window of account.limitWindows) {
      if (window.windowMinutes === null && window.utilization === 0
        && !timestamp(window.resetAt) && window.status === null) continue;
      add(windowLabel(window.windowMinutes, window.slot), window.utilization, window.resetAt);
    }
  } else {
    add("5 hours", account.fiveHourUtilization, account.fiveHourResetAt);
    add("Weekly", account.sevenDayUtilization, account.sevenDayResetAt);
    for (const [family, quota] of Object.entries(account.familyWeekly)) {
      if (quota) add(`Weekly (${family.charAt(0).toUpperCase()}${family.slice(1)})`, quota.utilization, quota.resetAt);
    }
  }
  return windows;
}

export function accountPoolLimits(accounts: z.infer<typeof poolAccountsSchema>): UnifiedProviderLimit[] {
  return accounts.flatMap((account): UnifiedProviderLimit[] => {
    if (account.provider !== "claude" && account.provider !== "codex") return [];
    const windows = accountWindows(account);
    return [{
      id: `account-pool:${account.id}`,
      providerId: account.provider,
      providerName: account.provider === "claude" ? "Claude Code" : "Codex",
      accountEmail: account.email,
      planLabel: account.subscriptionType,
      windows,
      status: account.error || account.status === "error" ? "error" : "ok",
      error: account.error ?? (account.status === "error" ? "Account Pooler could not load this account’s limits." : null),
      lastUpdatedAt: timestamp(account.observedAt),
      machines: [],
      poolAccount: {
        id: account.id,
        label: account.label,
        status: !account.enabled ? "disabled" : account.status,
        emptyMessage: account.kind === "api-key"
          ? "Subscription limits aren’t available for API key accounts."
          : "No usage limits reported yet.",
      },
    }];
  });
}

function emailKey(limit: UnifiedProviderLimit) {
  const email = limit.accountEmail?.trim().toLowerCase();
  return email ? `${limit.providerId}:${email}` : null;
}

function localWindowsForPool(local: UnifiedProviderLimit, pool: UnifiedProviderLimit) {
  // BB's local provider bridges use these labels for the same quota windows.
  const aliases: Record<string, string> = { "weekly limit": "Weekly", "current session": "5 hours" };
  return local.windows.map((window) => {
    const label = aliases[window.label.trim().toLowerCase()];
    return label && pool.windows.some((candidate) => candidate.label === label)
      ? { ...window, label }
      : window;
  });
}

export function mergeAccountPoolLimits(
  local: UnifiedProviderLimit[], pooled: UnifiedProviderLimit[], refreshedAccountId?: string,
) {
  const merged = new Set<string>();
  const limits = pooled.map((pool) => {
    const key = emailKey(pool);
    if (!key || pooled.filter((candidate) => emailKey(candidate) === key).length !== 1) return pool;
    const match = local.find((candidate) => emailKey(candidate) === key);
    if (!match) return pool;
    merged.add(match.id);
    return {
      ...pool,
      // A pool summary may be partial or cached. Preserve both sources using
      // the same reset-cycle rules as subscriptions shared across machines.
      // A reading just refreshed upstream is authoritative for its windows,
      // since a redeemed reset can lower usage without moving the reset time.
      windows: refreshedAccountId !== undefined && pool.poolAccount?.id === refreshedAccountId
        ? [...pool.windows, ...localWindowsForPool(match, pool)
          .filter((window) => !pool.windows.some((candidate) => candidate.label.trim().toLowerCase() === window.label.trim().toLowerCase()))]
        : mergeLimitWindows([pool, { windows: localWindowsForPool(match, pool) }]),
      planLabel: pool.planLabel ?? match.planLabel,
      machines: match.machines,
      ...(match.resetCredits && pool.planLabel?.trim().toLowerCase() === match.planLabel?.trim().toLowerCase()
        ? { resetCredits: match.resetCredits } : {}),
    };
  });
  return [...local.filter((limit) => !merged.has(limit.id)), ...limits];
}

const refreshedAccountSchema = z.object({ account: poolAccountsSchema.element.nullable() });

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createAccountPoolLimitsLoader(bb: BbPluginApi, timeoutMs = 5000, refreshTimeoutMs = 15_000) {
  let cached: UnifiedProviderLimit[] = [];
  return async (options: { refreshAccountId?: string } = {}): Promise<{
    limits: UnifiedProviderLimit[]; error: string | null; refreshedAccountId?: string;
  }> => {
    try {
      const installed = await withTimeout(
        bb.sdk.plugins.list({ signal: AbortSignal.timeout(timeoutMs) }), timeoutMs, "The account list timed out.",
      );
      if (!installed.plugins.some((plugin) => plugin.id === "account-pool" && plugin.enabled)) {
        cached = [];
        return { limits: cached, error: null };
      }
      // account.list only returns stored quotas, so a reset made on the
      // provider's site stays hidden until the pool's next background poll
      // unless the account is refreshed upstream first.
      let refreshedAccountId: string | undefined;
      let refreshError: string | null = null;
      if (options.refreshAccountId) {
        const startedAt = Date.now();
        try {
          const { account } = await withTimeout(bb.sdk.plugins.callRpc({
            pluginId: "account-pool", method: "account.refreshUsage",
            input: { accountId: options.refreshAccountId }, outputSchema: refreshedAccountSchema,
          }), refreshTimeoutMs, "The account refresh timed out.");
          // The pool resolves even when the upstream read fails or is skipped,
          // so only a new error-free observation counts as refreshed.
          if (account && !account.error && account.status !== "error"
            && account.observedAt !== null && account.observedAt >= startedAt) {
            refreshedAccountId = account.id;
          } else if (account) {
            refreshError = "Account Pooler couldn’t confirm fresh limits for this account. Showing the last reported values.";
          }
        } catch (reason) {
          bb.log.debug(`Account Pooler refresh unavailable: ${reason instanceof Error ? reason.message : String(reason)}`);
          refreshError = "Couldn’t refresh this Account Pooler account. Showing the last reported values.";
        }
      }
      const accounts = await withTimeout(bb.sdk.plugins.callRpc({
        pluginId: "account-pool", method: "account.list", input: null, outputSchema: poolAccountsSchema,
      }), timeoutMs, "The account list timed out.");
      cached = accountPoolLimits(accounts);
      if (!refreshError) return { limits: cached, error: null, ...(refreshedAccountId ? { refreshedAccountId } : {}) };
      // The stored reading may predate the reset, so it must not look current.
      return {
        limits: cached.map((limit) => limit.poolAccount?.id === options.refreshAccountId
          ? { ...limit, status: "error" as const, error: limit.error ?? refreshError }
          : limit),
        error: refreshError,
      };
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      bb.log.debug(`Account Pooler limits unavailable: ${message}`);
      return {
        limits: cached.map((limit) => ({
          ...limit,
          status: "error" as const,
          error: limit.error ?? "Account Pooler couldn’t refresh. Showing the last reported values.",
        })),
        error: `Couldn’t refresh Account Pooler limits.${cached.length ? " Showing the last reported pool limits." : ""}`,
      };
    }
  };
}
