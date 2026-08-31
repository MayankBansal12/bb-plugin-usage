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

  it("unifies one subscription across agents and machines without double-counting account-wide windows", () => {
    const shared = {
      providerId: "codex",
      providerName: "Codex",
      accountEmail: "dev@example.com",
      planLabel: "Pro",
      status: "ok" as const,
      error: null,
      lastUpdatedAt: null,
    };
    const grouped = groupProviderLimits([
      { ...shared, machineId: "one", machineName: "Laptop", agentId: "codex", agentName: "Codex", windows: [{ label: "5 hours", usedPercent: 42, resetsAt: null }] },
      { ...shared, machineId: "one", machineName: "Laptop", agentId: "pi", agentName: "Pi", windows: [{ label: "5 hours", usedPercent: 42, resetsAt: null }] },
      { ...shared, machineId: "two", machineName: "Desktop", agentId: "pi", agentName: "Pi", windows: [{ label: "5 hours", usedPercent: 45, resetsAt: null }] },
      { ...shared, accountEmail: null, machineId: "two", machineName: "Desktop", agentId: "prime", agentName: "Prime Agent", windows: [{ label: "5 hours", usedPercent: 45, resetsAt: null }] },
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ providerId: "codex", accountEmail: "dev@example.com" });
    expect(grouped[0]?.windows[0]?.usedPercent).toBe(45);
    expect(grouped[0]?.machines).toEqual([
      expect.objectContaining({ machineId: "two", agents: [{ id: "pi", name: "Pi" }, { id: "prime", name: "Prime Agent" }] }),
      expect.objectContaining({ machineId: "one", agents: [{ id: "codex", name: "Codex" }, { id: "pi", name: "Pi" }] }),
    ]);
  });

  it("keeps different accounts for the same provider separate", () => {
    const base = {
      machineId: "one", machineName: "Laptop", agentId: "pi", agentName: "Pi",
      providerId: "codex", providerName: "Codex", planLabel: "Pro", windows: [],
      status: "error" as const, error: "unavailable", lastUpdatedAt: null,
    };
    expect(groupProviderLimits([
      { ...base, accountEmail: "first@example.com" },
      { ...base, accountEmail: "second@example.com" },
    ])).toHaveLength(2);
  });
});
