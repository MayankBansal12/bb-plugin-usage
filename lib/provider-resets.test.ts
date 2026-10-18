import { describe, expect, it } from "vitest";
import type { UnifiedProviderLimit } from "./provider-limits";
import { providerResetAction, resetCreditExpiry } from "./provider-resets";

const now = Date.parse("2026-10-17T12:00:00Z");
const later = "2026-10-18T12:00:00.000Z";
function limit(overrides: Partial<UnifiedProviderLimit> = {}): UnifiedProviderLimit {
  return {
    id: "codex:personal", providerId: "codex", providerName: "Codex", accountEmail: "user@example.com",
    planLabel: "Pro", status: "ok", error: null, lastUpdatedAt: null, machines: [],
    windows: [{ label: "5 hours", usedPercent: 81, resetsAt: later }],
    resetCredits: { availableCount: 1, credits: [{ expiresAt: later }] }, ...overrides,
  };
}

describe("reset shortcuts", () => {
  it.each(["5 hours", "Current session", "Weekly", "Weekly limit", "Weekly (Sonnet)", "7 days"])(
    "appears strictly below 20%% remaining in %s", (label) => {
      for (const usedPercent of [0, 79.9, 80]) {
        expect(providerResetAction(limit({ windows: [{ label, usedPercent, resetsAt: later }] }), now)).toBeNull();
      }
      for (const usedPercent of [80.01, 99, 100, 120]) {
        expect(providerResetAction(limit({ windows: [{ label, usedPercent, resetsAt: later }] }), now)?.label).toBe("Reset usage");
      }
    },
  );

  it("triggers for either window independently", () => {
    expect(providerResetAction(limit({ windows: [
      { label: "5 hours", usedPercent: 0, resetsAt: later },
      { label: "Weekly", usedPercent: 90, resetsAt: later },
    ] }), now)).not.toBeNull();
  });

  it("links to reset options when availability is unknown and the account is at its limit", () => {
    for (const providerId of ["claude", "codex"]) {
      for (const planLabel of ["Pro", "prolite", "team"]) {
        expect(providerResetAction(limit({
          providerId, planLabel, resetCredits: undefined,
          windows: [{ label: "5 hours", usedPercent: 100, resetsAt: later }],
        }), now)).toEqual({
          label: "Reset options",
          href: providerId === "codex" ? "https://chatgpt.com/codex/settings/usage" : "https://claude.ai/settings/usage",
        });
      }
    }
  });

  it("offers a verified reset without requiring expiry details or a particular plan", () => {
    expect(providerResetAction(limit({ resetCredits: { availableCount: 1, credits: null } }), now)?.label).toBe("Reset usage");
    expect(providerResetAction(limit({ planLabel: "team" }), now)?.label).toBe("Reset usage");
  });

  it("keeps unknown reset options hidden until usage is low", () => {
    expect(providerResetAction(limit({
      resetCredits: undefined, windows: [{ label: "Weekly", usedPercent: 80, resetsAt: later }],
    }), now)).toBeNull();
  });

  it("does not offer resets for zero credits, expired credits, errors, or disabled accounts", () => {
    for (const overrides of [
      { resetCredits: { availableCount: 0, credits: null } },
      { resetCredits: { availableCount: 1, credits: [{ expiresAt: new Date(now).toISOString() }] } },
      { status: "error" as const }, { error: "Cached limits" }, { providerId: "cursor" },
      { poolAccount: { id: "pool", label: "Personal", status: "disabled", emptyMessage: "" } },
    ]) expect(providerResetAction(limit(overrides), now)).toBeNull();
  });

  it("ignores other windows, monetary caps, invalid percentages, and elapsed rollovers", () => {
    for (const window of [
      { label: "Monthly", usedPercent: 100, resetsAt: later },
      { label: "Code review", usedPercent: 100, resetsAt: later },
      { label: "5 hours", usedPercent: Number.NaN, resetsAt: later },
      { label: "5 hours", usedPercent: Infinity, resetsAt: later },
      { label: "Weekly", usedPercent: 99, resetsAt: new Date(now).toISOString() },
      { label: "Weekly", usedPercent: 99, resetsAt: "invalid" },
      { label: "Weekly", usedPercent: 99, resetsAt: later, cost: { usedUsdCents: 99, limitUsdCents: 100 } },
    ]) expect(providerResetAction(limit({ windows: [window] }), now)).toBeNull();
  });
});

describe("reset offer expiry", () => {
  it("shows the soonest future expiry and removes expired offers as time advances", () => {
    const summary = { availableCount: 3, credits: [
      { expiresAt: later }, { expiresAt: "2026-10-17T13:15:00.000Z" }, { expiresAt: "2026-10-17T11:00:00.000Z" },
    ] };
    expect(resetCreditExpiry(summary, now)).toEqual({ count: 2, label: "Next expires in 1h 15m", expiresAt: "2026-10-17T13:15:00.000Z" });
    expect(resetCreditExpiry(summary, Date.parse(later))).toBeNull();
    expect(resetCreditExpiry({ availableCount: 1, credits: [{ expiresAt: later }] }, now)?.label).toBe("Expires in 1d");
  });

  it("distinguishes unknown, partial, and nonexpiring details", () => {
    expect(resetCreditExpiry({ availableCount: 2, credits: null }, now)?.label).toBe("Expiry unavailable");
    expect(resetCreditExpiry({ availableCount: 2, credits: [] }, now)?.label).toBe("Expiry unavailable");
    expect(resetCreditExpiry({ availableCount: 1, credits: [{}] }, now)?.label).toBe("Expiry unavailable");
    expect(resetCreditExpiry({ availableCount: 1, credits: [{ expiresAt: null }] }, now)?.label).toBe("No expiry");
    expect(resetCreditExpiry({ availableCount: 2, credits: [{ expiresAt: later }] }, now)?.label).toBe("Known reset expires in 1d");
  });
});
