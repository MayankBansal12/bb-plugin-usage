import { describe, expect, it } from "vitest";
import { clampPercent, formatLimitReset, formatLimitValue, groupProviderLimits } from "./provider-limits";

describe("provider limit presentation", () => {
  it("clamps percentages to the progress range", () => {
    expect(clampPercent(-4)).toBe(0);
    expect(clampPercent(42.4)).toBe(42.4);
    expect(clampPercent(118)).toBe(100);
  });

  it("formats nearby and multi-day reset times", () => {
    const now = Date.parse("2026-08-11T12:00:00.000Z");
    expect(formatLimitReset("2026-08-11T12:42:00.000Z", now)).toBe("Resets in 42m");
    expect(formatLimitReset("2026-08-11T14:15:00.000Z", now)).toBe("Resets in 2h 15m");
    expect(formatLimitReset("2026-08-13T12:00:00.000Z", now)).toBe("Resets in 2d");
    expect(formatLimitReset(null, now)).toBeNull();
  });

  it("prefers an exact spend limit when a provider reports one", () => {
    expect(formatLimitValue({
      label: "Monthly",
      usedPercent: 25,
      resetsAt: null,
      cost: { usedUsdCents: 1250, limitUsdCents: 5000 },
    })).toBe("$12.50 of $50.00");
    expect(formatLimitValue({ label: "Weekly", usedPercent: 47.6, resetsAt: null })).toBe("48% used");
  });

  it("unifies one subscription across machines without double-counting account-wide windows", () => {
    const shared = {
      providerId: "claude",
      providerName: "Claude Code",
      accountEmail: "dev@example.com",
      planLabel: "Max",
      status: "ok" as const,
      error: null,
      lastUpdatedAt: null,
    };
    const grouped = groupProviderLimits([
      { ...shared, machineId: "one", machineName: "Studio", agentId: "claude", agentName: "Claude Code", windows: [{ label: "5 hours", usedPercent: 30, resetsAt: null }] },
      { ...shared, machineId: "two", machineName: "Air", agentId: "claude", agentName: "Claude Code", windows: [{ label: "5 hours", usedPercent: 32, resetsAt: null }] },
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.windows[0]?.usedPercent).toBe(32);
    expect(grouped[0]?.windows[0]).toEqual({ label: "5 hours", usedPercent: 32, resetsAt: null });
    expect(grouped[0]?.machines.map((machine) => machine.machineName).sort()).toEqual(["Air", "Studio"]);
  });

  it("keeps different accounts and unlabeled different plans on separate cards", () => {
    const base = {
      machineId: "one", machineName: "Studio", agentId: "claude", agentName: "Claude Code",
      providerId: "claude", providerName: "Claude Code", windows: [{ label: "5 hours", usedPercent: 10, resetsAt: null }],
      status: "ok" as const, error: null, lastUpdatedAt: null,
    };
    expect(groupProviderLimits([
      { ...base, accountEmail: "first@example.com", planLabel: "Max" },
      { ...base, accountEmail: "second@example.com", planLabel: "Max" },
    ])).toHaveLength(2);
    expect(groupProviderLimits([
      { ...base, accountEmail: null, planLabel: "Max" },
      { ...base, machineId: "two", machineName: "Air", accountEmail: null, planLabel: "Pro" },
    ])).toHaveLength(2);
  });
});
