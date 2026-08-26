import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OPENCODE_GO_USAGE_URL, openCodeGoUsageCommand, parseOpenCodeGoUsage } from "./opencode-go";

const samplePayload = JSON.stringify({
  usage: {
    rolling: { status: "ok", percent: 4, resetsAt: "2026-08-21T22:54:37.384Z" },
    weekly: { status: "ok", percent: 25, resetsAt: "2026-08-24T00:00:00.384Z" },
    monthly: { status: "rate-limited", percent: 88, resetsAt: "2026-09-19T19:49:17.384Z" },
  },
});

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true });
  tempDirs.length = 0;
});

interface RunCommandOptions {
  auth?: string | Record<string, unknown> | null;
  body?: string;
  curlExit?: number;
  http?: number;
  nodeOnly?: boolean;
}

function runUsageCommand({
  auth = { "opencode-go": { type: "api", key: "go-test-secret-do-not-log" } },
  body = samplePayload,
  curlExit,
  http = 200,
  nodeOnly = false,
}: RunCommandOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "bb-opencode-go-"));
  tempDirs.push(root);
  const dataDir = join(root, "data");
  const authPath = join(dataDir, "opencode", "auth.json");
  const binDir = join(root, "bin");
  const commandTmpDir = join(root, "tmp");
  mkdirSync(dirname(authPath), { recursive: true });
  mkdirSync(binDir);
  mkdirSync(commandTmpDir);
  if (auth !== null) {
    writeFileSync(authPath, typeof auth === "string" ? auth : JSON.stringify(auth));
  }

  const curlPath = join(binDir, "curl");
  writeFileSync(curlPath, `#!/bin/sh
header=$(cat)
if [ "$header" != "Authorization: Bearer $EXPECTED_KEY" ]; then
  printf '%s\\n' 'unexpected authorization header' >&2
  exit 9
fi
output=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    -w) shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$FAKE_CURL_EXIT" ]; then
  exit "$FAKE_CURL_EXIT"
fi
printf '%s' "$FAKE_BODY" > "$output"
printf '%s' "$FAKE_HTTP"
`);
  chmodSync(curlPath, 0o755);

  let path = `${binDir}:${process.env.PATH ?? ""}`;
  if (nodeOnly) {
    for (const [name, target] of [
      ["node", process.execPath],
      ["cat", "/usr/bin/cat"],
      ["mktemp", "/usr/bin/mktemp"],
      ["rm", "/usr/bin/rm"],
    ] as const) {
      symlinkSync(target, join(binDir, name));
    }
    path = binDir;
  }

  const result = spawnSync("/bin/sh", ["-c", openCodeGoUsageCommand()], {
    encoding: "utf8",
    env: {
      ...process.env,
      EXPECTED_KEY: "go-test-secret-do-not-log",
      FAKE_BODY: body,
      FAKE_CURL_EXIT: curlExit === undefined ? "" : String(curlExit),
      FAKE_HTTP: String(http),
      PATH: path,
      TMPDIR: commandTmpDir,
      XDG_DATA_HOME: dataDir,
    },
  });
  return {
    output: `${result.stdout}${result.stderr}`,
    status: result.status,
    tempFiles: readdirSync(commandTmpDir),
  };
}

describe("OpenCode Go command", () => {
  it("reads the Go credential without printing it and calls the Zen usage endpoint", () => {
    const command = openCodeGoUsageCommand();
    expect(command).toContain('"${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json"');
    expect(command).toContain(OPENCODE_GO_USAGE_URL);
    expect(command).toContain("Authorization: Bearer %s");
    expect(command).toContain("-H @-");
    expect(command).not.toContain("Authorization: Bearer $bb_usage_go_key");
    expect(command).toContain('has("opencode-go")');
    expect(command).toContain("no-opencode-go-credential");
    expect(command).toContain("__BB_USAGE_BEGIN__");
    expect(command).toContain("__BB_USAGE_END__:0");
    expect(command).toContain("set +x");
    expect(command).toContain("mktemp");
    expect(command).toContain("rm -f");
    expect(command).toContain("trap");
    expect(command).toContain("curl -q -sS -m 20 --proto '=https'");
    expect(command).toContain("-w '%{http_code}'");
    expect(command).toContain("= 403 ");
    expect(command).toContain("EntitlementError");
  });

  it("falls back from jq to node for credential extraction", () => {
    const command = openCodeGoUsageCommand();
    expect(command).toContain("command -v jq");
    expect(command).toContain("command -v node");
    expect(command).toContain('readFileSync(process.argv[1],"utf8")');
    expect(command).toContain('.type == "api"');
    expect(command).toContain("jq or Node.js is required");
  });

  it("executes the jq collector without exposing the credential", () => {
    const result = runUsageCommand();
    expect(result.status).toBe(0);
    expect(result.output).toContain("__BB_USAGE_BEGIN__");
    expect(result.output).toContain(samplePayload);
    expect(result.output).toContain("__BB_USAGE_END__:0");
    expect(result.output).not.toContain("go-test-secret-do-not-log");
    expect(result.tempFiles).toEqual([]);
  });

  it("supports the legacy api_key field through the Node.js fallback", () => {
    const result = runUsageCommand({
      auth: { "opencode-go": { type: "api", api_key: "go-test-secret-do-not-log" } },
      nodeOnly: true,
    });
    expect(result.status).toBe(0);
    expect(result.output).toContain(samplePayload);
    expect(result.output).not.toContain("go-test-secret-do-not-log");
    expect(result.tempFiles).toEqual([]);
  });

  it("distinguishes an absent credential from malformed auth", () => {
    const missingFile = runUsageCommand({ auth: null });
    expect(missingFile.status).not.toBe(0);
    expect(missingFile.output).toContain("no-opencode-go-credential");

    for (const nodeOnly of [false, true]) {
      const missingEntry = runUsageCommand({ auth: {}, nodeOnly });
      expect(missingEntry.status).not.toBe(0);
      expect(missingEntry.output).toContain("no-opencode-go-credential");
    }

    const malformed = runUsageCommand({ auth: "{" });
    expect(malformed.status).not.toBe(0);
    expect(malformed.output).toContain("auth file was not valid JSON");
    expect(malformed.output).not.toContain("no-opencode-go-credential");
  });

  it.each([
    ["array", []],
    ["primitive", "token"],
    ["null", null],
    ["wrong type", { type: "oauth", key: "go-test-secret-do-not-log" }],
  ])("treats a present %s entry as invalid in both parser paths", (_label, entry) => {
    for (const nodeOnly of [false, true]) {
      const result = runUsageCommand({ auth: { "opencode-go": entry }, nodeOnly });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("invalid");
      expect(result.output).not.toContain("no-opencode-go-credential");
      expect(result.output).not.toContain("go-test-secret-do-not-log");
    }
  });

  it("rejects invalid credential values without exposing them", () => {
    const result = runUsageCommand({
      auth: { "opencode-go": { type: "api", key: "invalid key" } },
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("credential was invalid");
    expect(result.output).not.toContain("invalid key");
  });

  it("maps only an entitlement 403 to a missing Go plan", () => {
    const noPlan = runUsageCommand({
      body: JSON.stringify({ error: { type: "EntitlementError" } }),
      http: 403,
    });
    expect(noPlan.status).not.toBe(0);
    expect(noPlan.output).toContain("no-opencode-go-plan");
    expect(noPlan.tempFiles).toEqual([]);

    const forbidden = runUsageCommand({
      body: JSON.stringify({ error: { type: "ForbiddenError" } }),
      http: 403,
    });
    expect(forbidden.status).not.toBe(0);
    expect(forbidden.output).toContain("returned HTTP 403");
    expect(forbidden.output).not.toContain("no-opencode-go-plan");
    expect(forbidden.tempFiles).toEqual([]);
  });

  it.each([401, 429, 500])("reports HTTP %i as a retriable collector error", (http) => {
    const result = runUsageCommand({ body: "{}", http });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(`returned HTTP ${http}`);
    expect(result.tempFiles).toEqual([]);
  });

  it("reports transport failures and removes the response file", () => {
    const result = runUsageCommand({ curlExit: 7 });
    expect(result.status).toBe(7);
    expect(result.output).toContain("usage request failed");
    expect(result.tempFiles).toEqual([]);
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
