import { describe, expect, it } from "vitest";
import { getEmptyUsageView, getSourceIssueMessage } from "./usage-view-state";

const connected = { id: "machine-a", name: "Workstation", status: "connected" };
const offline = { id: "machine-a", name: "Workstation", status: "offline" };

describe("usage view state", () => {
  it("identifies an offline machine instead of presenting it as no usage", () => {
    expect(getEmptyUsageView({
      machines: [offline],
      sources: [{ machineId: offline.id, status: "offline" }],
      hasRecordsOutsideView: false,
    })).toMatchObject({ kind: "offline", title: "Workstation is offline" });
  });

  it("distinguishes a completed scan with no logs from a collection error", () => {
    expect(getEmptyUsageView({
      machines: [connected],
      sources: [{ machineId: connected.id, status: "no-data" }],
      hasRecordsOutsideView: false,
    }).kind).toBe("no-data");

    expect(getEmptyUsageView({
      machines: [connected],
      sources: [{ machineId: connected.id, status: "unavailable" }],
      hasRecordsOutsideView: false,
    })).toMatchObject({ kind: "error", title: "Usage couldn’t be collected" });
  });

  it("recognizes records excluded only by the current range", () => {
    expect(getEmptyUsageView({
      machines: [connected],
      sources: [{ machineId: connected.id, status: "ready" }],
      hasRecordsOutsideView: true,
    }).kind).toBe("filtered");
  });

  it("builds an actionable partial-history message", () => {
    expect(getSourceIssueMessage(
      [offline],
      [{ machineId: offline.id, status: "offline" }, { machineId: offline.id, status: "partial" }],
    )).toBe("Workstation is offline; 1 agent scan failed or was incomplete. Available records are included.");
  });
});
