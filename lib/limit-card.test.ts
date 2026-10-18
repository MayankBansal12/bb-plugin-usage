import { describe, expect, it } from "vitest";
import { limitAccountLabel, limitCardNotice, limitStatusTag } from "./limit-card";
import type { UnifiedProviderLimit } from "./provider-limits";

const now = Date.parse("2026-10-17T12:00:00.000Z");

function machine(name: string, error: string | null = null): UnifiedProviderLimit["machines"][number] {
  return {
    machineId: name,
    machineName: name,
    agents: [],
    windows: [],
    status: error ? "error" : "ok",
    error,
    lastUpdatedAt: null,
  };
}

function limit(overrides: Partial<UnifiedProviderLimit> = {}): UnifiedProviderLimit {
  return {
    id: "codex",
    providerId: "codex",
    providerName: "Codex",
    accountEmail: "person@example.com",
    planLabel: "team",
    windows: [{ label: "Weekly", usedPercent: 8, resetsAt: null }],
    status: "ok",
    error: null,
    lastUpdatedAt: "2026-10-17T09:00:00.000Z",
    machines: [machine("fedora")],
    ...overrides,
  };
}

const pool = (status: string) => ({ id: "a", label: "person@example.com (laptop)", status, emptyMessage: "No usage limits reported yet." });

describe("limit card presentation", () => {
  it("has no notice for healthy limits", () => {
    expect(limitCardNotice(limit(), now)).toBeNull();
  });

  it("summarizes an authentication failure and keeps the full masked diagnostic", () => {
    const error = "OAuth refresh failed with HTTP 401 for person@example.com. refresh_token_invalidated";
    expect(limitCardNotice(limit({ status: "error", error, poolAccount: pool("error") }), now)).toEqual({
      title: "Authentication failed in Account Pooler",
      stale: { label: "Showing values from 3h ago", at: "2026-10-17T09:00:00.000Z" },
      details: ["OAuth refresh failed with HTTP 401 for p···n@e···e.com. refresh_token_invalidated"],
    });
  });

  it("keeps the stale indicator in the summary when cached values are shown", () => {
    const notice = limitCardNotice(limit({ status: "error", error: "request timed out" }), now);
    expect(notice?.title).toBe("Couldn’t refresh limits");
    expect(notice?.stale?.label).toBe("Showing values from 3h ago");
    expect(limitCardNotice(limit({ status: "error", error: "request timed out", lastUpdatedAt: null }), now)?.stale)
      .toEqual({ label: "Showing last reported values", at: null });
  });

  it("does not claim stale values when nothing is shown", () => {
    const notice = limitCardNotice(limit({ status: "error", error: "request timed out", windows: [] }), now);
    expect(notice).toMatchObject({ title: "Couldn’t load limits", stale: null });
  });

  it("does not apply the pool's stale age to mixed local and pool values", () => {
    const local = { ...machine("laptop"), windows: [{ label: "Weekly", usedPercent: 8, resetsAt: null }] };
    const notice = limitCardNotice(limit({
      status: "error", error: "HTTP 401", poolAccount: pool("error"), machines: [local],
    }), now);
    expect(notice?.stale).toEqual({ label: "Some sources could not refresh", at: null, partial: true });
    expect(notice?.details.at(-1)).toContain("Account Pooler last updated");
  });

  it("marks previously healthy local values stale after the whole request fails", () => {
    const local = { ...machine("laptop"), windows: [{ label: "Weekly", usedPercent: 8, resetsAt: null }] };
    const notice = limitCardNotice(limit({ poolAccount: pool("ready"), machines: [local] }), now, true);
    expect(notice).toMatchObject({
      title: "Couldn’t refresh limits", stale: { label: "Showing values from 3h ago", at: "2026-10-17T09:00:00.000Z" },
    });
    expect(notice?.stale?.partial).toBeUndefined();
  });

  it("bounds partial multi-machine titles and lists each machine in the details", () => {
    const notice = limitCardNotice(limit({
      error: "HTTP 500; timed out",
      machines: [machine("fedora"), machine("mayank-redmibook", "HTTP 500"), machine("work-desktop", "timed out")],
    }), now);
    expect(notice).toEqual({
      title: "Couldn’t refresh 2 machines",
      stale: null,
      details: ["mayank-redmibook: HTTP 500", "work-desktop: timed out"],
    });
    expect(limitCardNotice(limit({
      error: "HTTP 401",
      machines: [machine("fedora"), machine("laptop", "HTTP 401")],
    }), now)?.title).toBe("Authentication failed on laptop");
  });

  it("drops the duplicate Error tag when the notice explains it", () => {
    expect(limitStatusTag(limit({ status: "error", error: "HTTP 401", poolAccount: pool("error") }))).toBeNull();
    expect(limitStatusTag(limit({ poolAccount: pool("error") }))).toEqual({ label: "Error", tone: "danger" });
    expect(limitStatusTag(limit({ poolAccount: pool("exhausted") }))).toEqual({ label: "Limit reached", tone: "danger" });
    expect(limitStatusTag(limit({ poolAccount: pool("disabled") }))).toEqual({ label: "Disabled", tone: "muted" });
    expect(limitStatusTag(limit({ poolAccount: pool("ready") }))).toBeNull();
    expect(limitStatusTag(limit())).toBeNull();
  });

  it("masks account labels", () => {
    expect(limitAccountLabel(limit({ poolAccount: pool("ready") }))).toBe("p···n@e···e.com (laptop)");
    expect(limitAccountLabel(limit({ accountEmail: null }))).toBe("");
  });

  it("shows the email alongside a pool nickname, without duplicating default labels", () => {
    expect(limitAccountLabel(limit({ poolAccount: { ...pool("ready"), label: "Mayank" } })))
      .toBe("p···n@e···e.com · Mayank");
    expect(limitAccountLabel(limit({ poolAccount: { ...pool("ready"), label: "PERSON@example.com" } })))
      .toBe("p···n@e···e.com");
    expect(limitAccountLabel(limit({ accountEmail: null, poolAccount: { ...pool("ready"), label: "Mayank" } })))
      .toBe("Mayank");
  });
});
