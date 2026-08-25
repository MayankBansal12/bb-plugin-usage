import { describe, expect, it } from "vitest";
import { OPENCODE_GO_USAGE_URL, openCodeGoUsageCommand, parseOpenCodeGoUsage } from "./opencode-go";

const samplePayload = JSON.stringify({
  usage: {
    rolling: { status: "ok", percent: 4, resetsAt: "2026-08-21T22:54:37.384Z" },
    weekly: { status: "ok", percent: 25, resetsAt: "2026-08-24T00:00:00.384Z" },
    monthly: { status: "rate-limited", percent: 88, resetsAt: "2026-09-19T19:49:17.384Z" },
  },
});

describe("OpenCode Go command", () => {
  it("reads the Go credential without printing it and calls the Zen usage endpoint", () => {
    const command = openCodeGoUsageCommand();
    expect(command).toContain('"${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json"');
    expect(command).toContain(OPENCODE_GO_USAGE_URL);
    expect(command).toContain("Authorization: Bearer %s");
    expect(command).toContain("-H @-");
    expect(command).not.toContain("Authorization: Bearer $bb_usage_go_key");
    expect(command).toContain('."opencode-go" | select(.type == "api")');
    expect(command).toContain("no-opencode-go-credential");
    expect(command).toContain("__BB_USAGE_BEGIN__");
    expect(command).toContain("__BB_USAGE_END__:0");
    expect(command).toContain("mktemp");
    expect(command).toContain("rm -f");
    expect(command).toContain("trap");
    expect(command).toMatch(/curl -sS -m 20/);
    expect(command).toContain("-w '%{http_code}'");
    expect(command).toContain("= 403 ");
  });

  it("falls back from jq to node for credential extraction", () => {
    const command = openCodeGoUsageCommand();
    expect(command).toContain("command -v jq");
    expect(command).toContain("command -v node");
    expect(command).toContain('readFileSync(process.argv[1],"utf8")');
    expect(command).toContain('.type == "api"');
    expect(command).toContain("jq or Node.js is required");
  });
});

describe("OpenCode Go usage parsing", () => {
  it("maps rolling, weekly, and monthly windows in order", () => {
    expect(parseOpenCodeGoUsage(samplePayload)).toEqual([
      { label: "Rolling (5h)", usedPercent: 4, resetsAt: "2026-08-21T22:54:37.384Z" },
      { label: "Weekly", usedPercent: 25, resetsAt: "2026-08-24T00:00:00.384Z" },
      { label: "Monthly", usedPercent: 88, resetsAt: "2026-09-19T19:49:17.384Z" },
    ]);
  });

  it("skips absent windows and keeps partial payloads", () => {
    expect(parseOpenCodeGoUsage(JSON.stringify({
      usage: { weekly: { status: "ok", percent: 12 } },
    }))).toEqual([{ label: "Weekly", usedPercent: 12, resetsAt: null }]);
  });

  it("nulls out unparsable reset timestamps", () => {
    expect(parseOpenCodeGoUsage(JSON.stringify({
      usage: { rolling: { status: "ok", percent: 7, resetsAt: "not-a-date" } },
    }))).toEqual([{ label: "Rolling (5h)", usedPercent: 7, resetsAt: null }]);
  });

  it("clamps out-of-range percentages", () => {
    expect(parseOpenCodeGoUsage(JSON.stringify({
      usage: { monthly: { status: "rate-limited", percent: 140 } },
    }))).toEqual([{ label: "Monthly", usedPercent: 100, resetsAt: null }]);
  });

  it("rejects malformed and unexpected payloads", () => {
    expect(() => parseOpenCodeGoUsage("not json")).toThrow("not valid JSON");
    expect(() => parseOpenCodeGoUsage("{}")).toThrow("unexpected shape");
    expect(() => parseOpenCodeGoUsage(JSON.stringify({ usage: { rolling: { status: "ok" } } }))).toThrow("unexpected shape");
  });
});
