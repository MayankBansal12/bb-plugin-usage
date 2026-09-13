import type { BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import type { ProviderLimitWindow, UnifiedProviderLimit } from "./provider-limits";

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

export function mergeAccountPoolLimits(local: UnifiedProviderLimit[], pooled: UnifiedProviderLimit[]) {
  const merged = new Set<string>();
  const limits = pooled.map((pool) => {
    const key = emailKey(pool);
    if (!key || pooled.filter((candidate) => emailKey(candidate) === key).length !== 1) return pool;
    const match = local.find((candidate) => emailKey(candidate) === key);
    if (!match) return pool;
    merged.add(match.id);
    return { ...pool, planLabel: pool.planLabel ?? match.planLabel, machines: match.machines };
  });
  return [...local.filter((limit) => !merged.has(limit.id)), ...limits];
}

export function createAccountPoolLimitsLoader(bb: BbPluginApi, timeoutMs = 5000) {
  let cached: UnifiedProviderLimit[] = [];
  return async (): Promise<{ limits: UnifiedProviderLimit[]; error: string | null }> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = async () => {
        const installed = await bb.sdk.plugins.list({ signal: AbortSignal.timeout(timeoutMs) });
        if (!installed.plugins.some((plugin) => plugin.id === "account-pool" && plugin.enabled)) return [];
        const accounts = await bb.sdk.plugins.callRpc({
          pluginId: "account-pool", method: "account.list", input: null, outputSchema: poolAccountsSchema,
        });
        return accountPoolLimits(accounts);
      };
      cached = await Promise.race([
        request(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("The account list timed out.")), timeoutMs);
        }),
      ]);
      return { limits: cached, error: null };
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      bb.log.debug(`Account Pooler limits unavailable: ${message}`);
      return {
        limits: cached,
        error: `Couldn’t refresh Account Pooler limits.${cached.length ? " Showing the last reported pool limits." : ""}`,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
