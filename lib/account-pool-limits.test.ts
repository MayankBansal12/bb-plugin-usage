import type { BbPluginApi } from "@bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { accountPoolLimits, createAccountPoolLimitsLoader, mergeAccountPoolLimits, poolAccountsSchema } from "./account-pool-limits";
import { groupProviderLimits, isLimitVisibleOnMachine } from "./provider-limits";

function account(overrides: Partial<(typeof poolAccountsSchema)["_output"][number]> = {}) {
  return {
    id: "codex-one", provider: "codex", kind: "oauth" as const, label: "Personal",
    email: "user@example.com", subscriptionType: null, enabled: true, status: "ready", error: null,
    observedAt: Date.parse("2026-09-13T12:00:00Z"),
    fiveHourUtilization: null, fiveHourResetAt: null,
    sevenDayUtilization: null, sevenDayResetAt: null,
    familyWeekly: {}, limitWindows: [],
    ...overrides,
  };
}

const resetAt = Date.parse("2026-09-14T12:00:00Z");
const codexWindows = [
  { slot: "primary", windowMinutes: 300, utilization: 0.12, resetAt, status: null },
  { slot: "secondary", windowMinutes: 10080, utilization: 0.37, resetAt, status: null },
];

function localLimits(email: string | null = "user@example.com") {
  return groupProviderLimits([{
    machineId: "laptop", machineName: "Laptop", agentId: "codex", agentName: "Codex",
    providerId: "codex", providerName: "Codex", accountEmail: email, accountIdentity: null,
    planLabel: "Plus", windows: [{ label: "Weekly", usedPercent: 20, resetsAt: null }],
    status: "ok", error: null, lastUpdatedAt: null,
  }]);
}

describe("Account Pooler limits", () => {
  it("shows separate accounts and converts Codex fractions and timestamps", () => {
    const limits = accountPoolLimits([
      account({ limitWindows: codexWindows }),
      account({ id: "codex-two", label: "Work", email: "work@example.com", limitWindows: codexWindows }),
    ]);
    expect(limits).toHaveLength(2);
    expect(limits[0]).toMatchObject({
      id: "account-pool:codex-one", providerName: "Codex", machines: [],
      poolAccount: { label: "Personal", status: "ready" },
      lastUpdatedAt: "2026-09-13T12:00:00.000Z",
      windows: [
        { label: "5 hours", usedPercent: 12, resetsAt: "2026-09-14T12:00:00.000Z" },
        { label: "Weekly", usedPercent: 37, resetsAt: "2026-09-14T12:00:00.000Z" },
      ],
    });
    expect(limits[1]?.poolAccount?.label).toBe("Work");
  });

  it("uses actual durations for weekly-only plans and skips empty secondary placeholders", () => {
    const [limit] = accountPoolLimits([account({ limitWindows: [
      { slot: "primary", windowMinutes: 10080, utilization: 0.17, resetAt, status: null },
      { slot: "secondary", windowMinutes: null, utilization: 0, resetAt: 0, status: null },
    ] })]);
    expect(limit?.windows).toEqual([{ label: "Weekly", usedPercent: 17, resetsAt: "2026-09-14T12:00:00.000Z" }]);
  });

  it("keeps measured zero usage, omits unknown percentages, and does not invent reset dates", () => {
    const [limit] = accountPoolLimits([account({ observedAt: -1, limitWindows: [
      { slot: "primary", windowMinutes: 300, utilization: 0, resetAt: 0, status: null },
      { slot: "secondary", windowMinutes: 10080, utilization: null, resetAt, status: null },
    ] })]);
    expect(limit?.windows).toEqual([{ label: "5 hours", usedPercent: 0, resetsAt: null }]);
    expect(limit?.lastUpdatedAt).toBeNull();
  });

  it("includes Claude five-hour, weekly, and model-family quotas", () => {
    const [limit] = accountPoolLimits([account({
      provider: "claude", subscriptionType: "max", fiveHourUtilization: 0,
      fiveHourResetAt: resetAt, sevenDayUtilization: 0.42, sevenDayResetAt: resetAt,
      familyWeekly: { opus: { utilization: 0.61, resetAt }, sonnet: null },
    })]);
    expect(limit).toMatchObject({ providerName: "Claude Code", planLabel: "max" });
    expect(limit?.windows.map(({ label, usedPercent }) => ({ label, usedPercent }))).toEqual([
      { label: "5 hours", usedPercent: 0 }, { label: "Weekly", usedPercent: 42 },
      { label: "Weekly (Opus)", usedPercent: 61 },
    ]);
  });

  it("retains disabled, exhausted, errored, API key, and unobserved accounts", () => {
    const limits = accountPoolLimits([
      account({ id: "disabled", enabled: false }),
      account({ id: "exhausted", status: "exhausted", limitWindows: codexWindows }),
      account({ id: "error", status: "error", error: "Refresh failed", limitWindows: codexWindows }),
      account({ id: "key", provider: "claude", kind: "api-key", email: null }),
      account({ id: "unobserved", observedAt: null }),
    ]);
    expect(limits).toHaveLength(5);
    expect(limits[0]?.poolAccount?.status).toBe("disabled");
    expect(limits[1]).toMatchObject({ status: "ok", poolAccount: { status: "exhausted" } });
    expect(limits[2]).toMatchObject({ status: "error", error: "Refresh failed", windows: expect.any(Array) });
    expect(limits[2]?.windows).toHaveLength(2);
    expect(limits[3]?.poolAccount?.emptyMessage).toContain("API key");
    expect(limits[4]).toMatchObject({ windows: [], poolAccount: { emptyMessage: "No usage limits reported yet." } });
  });

  it("combines an unambiguous local account while retaining pool windows and global visibility", () => {
    const limits = mergeAccountPoolLimits(localLimits(" USER@EXAMPLE.COM "), accountPoolLimits([account({ limitWindows: codexWindows })]));
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({ planLabel: "Plus", machines: [{ machineId: "laptop" }] });
    expect(limits[0]?.windows[1]?.usedPercent).toBe(37);
    expect(isLimitVisibleOnMachine(limits[0]!, "different-machine")).toBe(true);
    expect(isLimitVisibleOnMachine(localLimits()[0]!, "different-machine")).toBe(false);
  });

  it("keeps accounts separate when email is missing, ambiguous, or belongs to another provider", () => {
    for (const email of [null, "user@example.com"]) {
      const pooled = accountPoolLimits([account({ email }), account({ id: "second", email })]);
      const limits = mergeAccountPoolLimits(localLimits(email), pooled);
      expect(limits).toHaveLength(3);
      expect(new Set(limits.map((limit) => limit.id)).size).toBe(3);
    }
    expect(mergeAccountPoolLimits(localLimits(), accountPoolLimits([account({ provider: "claude" })]))).toHaveLength(2);
  });

  it("validates the account-list boundary and discards unrelated fields", () => {
    const parsed = poolAccountsSchema.parse([{ ...account(), irrelevant: "ignored" }]);
    expect(parsed[0]).not.toHaveProperty("irrelevant");
    expect(() => poolAccountsSchema.parse([account({ limitWindows: [{ ...codexWindows[0]!, utilization: Number.NaN }] })])).toThrow();
  });
});

describe("optional pool integration", () => {
  function setup() {
    const list = vi.fn().mockResolvedValue({ plugins: [{ id: "account-pool", enabled: true }] });
    const callRpc = vi.fn().mockResolvedValue([account({ limitWindows: codexWindows })]);
    const bb = { sdk: { plugins: { list, callRpc } }, log: { debug: vi.fn() } } as unknown as BbPluginApi;
    return { bb, list, callRpc, load: createAccountPoolLimitsLoader(bb, 20) };
  }

  it("reads all accounts once without touching account credentials or refresh operations", async () => {
    const { load, callRpc } = setup();
    const result = await load();
    expect(result.error).toBeNull();
    expect(result.limits).toHaveLength(1);
    expect(callRpc).toHaveBeenCalledExactlyOnceWith({
      pluginId: "account-pool", method: "account.list", input: null, outputSchema: poolAccountsSchema,
    });
  });

  it("is silent when the pool is absent or disabled and clears previous accounts", async () => {
    const { load, list, callRpc } = setup();
    await load();
    for (const plugins of [[], [{ id: "account-pool", enabled: false }]]) {
      list.mockResolvedValue({ plugins });
      expect(await load()).toEqual({ limits: [], error: null });
    }
    expect(callRpc).toHaveBeenCalledTimes(1);
  });

  it("retains the last valid pool snapshot after a failure and removes deleted accounts after recovery", async () => {
    const { load, callRpc } = setup();
    const first = await load();
    callRpc.mockRejectedValueOnce(new Error("Pool reload in progress"));
    const failed = await load();
    expect(failed.limits).toEqual(first.limits);
    expect(failed.error).toContain("last reported");
    callRpc.mockResolvedValueOnce([]);
    expect(await load()).toEqual({ limits: [], error: null });
  });

  it("bounds a stalled pool RPC and reports failure without hiding other providers", async () => {
    const { load, callRpc } = setup();
    callRpc.mockImplementation(() => new Promise(() => {}));
    const result = await load();
    expect(result).toEqual({ limits: [], error: "Couldn’t refresh Account Pooler limits." });
    expect(mergeAccountPoolLimits(localLimits(), result.limits)).toHaveLength(1);
  });
});
