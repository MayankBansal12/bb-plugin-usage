import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { codexLaunch, codexResetsCommand, parseCodexResetSnapshot } from "./codex-resets";

const run = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function collect(usage: unknown, behavior = "normal") {
  const bin = await mkdtemp(join(tmpdir(), "bb-codex-resets-"));
  dirs.push(bin);
  const requests = join(bin, "requests.jsonl");
  await symlink(process.execPath, join(bin, "node"));
  await writeFile(join(bin, "codex"), `#!/usr/bin/env node
const fs = require('node:fs');
const input = require('node:readline').createInterface({ input: process.stdin });
input.on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(requests)}, line + '\\n');
  if (request.id == null) return;
  if (${JSON.stringify(behavior)} === 'exit') process.exit(1);
  if (${JSON.stringify(behavior)} === 'overflow') { process.stdout.write('x'.repeat(300000)); return; }
  const result = request.method === 'initialize' ? { serverInfo: { version: 'test' } }
    : request.method === 'account/read' ? { account: { type: 'chatgpt', email: 'user@example.com', planType: 'pro' }, secret: 'do-not-export' }
    : request.method === 'account/rateLimits/read' ? ${JSON.stringify(usage)} : null;
  console.log(JSON.stringify({ id: request.id, result }));
});
`, { mode: 0o755 });
  const { stdout } = await run("/bin/sh", ["-c", codexResetsCommand()], {
    env: { ...process.env, PATH: bin, NODE_OPTIONS: "" }, timeout: 15_000,
  });
  return { stdout, requests: (await readFile(requests, "utf8")).trim().split("\n").map((line) => JSON.parse(line)) };
}

describe("Codex reset collection", () => {
  it("uses only read requests and returns expiry metadata without protocol secrets", async () => {
    const { stdout, requests } = await collect({ rateLimitResetCredits: {
      availableCount: 2, credits: [{ id: "private-credit-id", title: "title", status: "available", resetType: "codexRateLimits", expiresAt: 1_800_000_000 }],
      secret: "do-not-export",
    }, secret: "do-not-export" });
    expect(requests.map((request) => request.method)).toEqual(["initialize", "initialized", "account/read", "account/rateLimits/read"]);
    expect(requests[0].params.capabilities.experimentalApi).toBe(true);
    expect(requests.at(-1).params.excludeResetCreditDetails).toBe(false);
    expect(stdout).not.toMatch(/do-not-export|private-credit-id/);
    expect(parseCodexResetSnapshot(stdout)).toEqual({
      accountEmail: "user@example.com", planType: "pro",
      resetCredits: { availableCount: 2, credits: [{ expiresAt: new Date(1_800_000_000_000).toISOString() }] },
    });
  });

  it("preserves zero, count-only, and nonexpiring results", async () => {
    for (const summary of [
      { availableCount: 0, credits: [] },
      { availableCount: 2, credits: null },
      { availableCount: 1, credits: [{ status: "available", resetType: "codexRateLimits", expiresAt: null }] },
    ]) {
      const { stdout } = await collect({ rateLimitResetCredits: summary });
      expect(parseCodexResetSnapshot(stdout)?.resetCredits).toEqual({
        availableCount: summary.availableCount, credits: summary.credits?.map(() => ({ expiresAt: null })) ?? null,
      });
    }
  });

  // availableCount counts only available credits (app-server protocol
  // RateLimitResetCreditsSummary), so other rows must not reduce it again.
  it("does not subtract redeemed credits from the available count", async () => {
    const { stdout } = await collect({ rateLimitResetCredits: {
      availableCount: 1, credits: [
        { status: "available", resetType: "codexRateLimits", expiresAt: 1_800_000_000 },
        { status: "redeemed", resetType: "codexRateLimits", expiresAt: 1_700_000_000 },
      ],
    } });
    expect(parseCodexResetSnapshot(stdout)?.resetCredits).toEqual({
      availableCount: 1, credits: [{ expiresAt: new Date(1_800_000_000_000).toISOString() }],
    });
  });

  it("ignores redeeming and unknown-status rows without lowering the count", async () => {
    const { stdout } = await collect({ rateLimitResetCredits: {
      availableCount: 2, credits: [
        { status: "available", resetType: "codexRateLimits", expiresAt: null },
        { status: "redeeming", resetType: "codexRateLimits", expiresAt: null },
        { status: "unknown", resetType: "codexRateLimits", expiresAt: null },
      ],
    } });
    // One detail row for two credits keeps the expiry incomplete, not zero.
    expect(parseCodexResetSnapshot(stdout)?.resetCredits).toEqual({ availableCount: 2, credits: [{ expiresAt: null }] });
  });

  it("excludes available credits of other reset types", async () => {
    const { stdout } = await collect({ rateLimitResetCredits: {
      availableCount: 2, credits: [
        { status: "available", resetType: "codexRateLimits", expiresAt: null },
        { status: "available", resetType: "unknown", expiresAt: null },
      ],
    } });
    expect(parseCodexResetSnapshot(stdout)?.resetCredits).toEqual({ availableCount: 1, credits: [{ expiresAt: null }] });
  });

  it("leaves availability unknown when only other reset types are available", async () => {
    const { stdout } = await collect({ rateLimitResetCredits: {
      availableCount: 1, credits: [{ status: "available", resetType: "unknown", expiresAt: null }],
    } });
    expect(parseCodexResetSnapshot(stdout)).toBeNull();
  });

  it("reports a known zero when nothing is available", async () => {
    const { stdout } = await collect({ rateLimitResetCredits: {
      availableCount: 0, credits: [{ status: "redeemed", resetType: "codexRateLimits", expiresAt: null }],
    } });
    expect(parseCodexResetSnapshot(stdout)?.resetCredits).toEqual({ availableCount: 0, credits: [] });
  });

  it.each([{}, { rateLimitResetCredits: { availableCount: "1" } }, { rateLimitResetCredits: { availableCount: 1, credits: [{}] } }])(
    "handles absent and unrecognized metadata without exporting raw payloads", async (usage) => {
      const { stdout } = await collect(usage);
      // Malformed rows and absent/invalid counts remain unknown.
      expect(parseCodexResetSnapshot(stdout)?.resetCredits.availableCount ?? null).not.toBe(1);
    },
  );

  it.each(["exit", "overflow"])("stops cleanly when the CLI produces %s", async (behavior) => {
    expect(parseCodexResetSnapshot((await collect({}, behavior)).stdout)).toBeNull();
  });

  it("rejects malformed or unbounded host snapshots", () => {
    const wrap = (data: unknown) => `__BB_CODEX_RESETS_BEGIN__\n${JSON.stringify(data)}\n__BB_CODEX_RESETS_END__`;
    for (const resetCredits of [
      { availableCount: -1, credits: null }, { availableCount: 1_000_000, credits: null },
      { availableCount: 1, credits: [{ expiresAt: "invalid" }] },
    ]) expect(parseCodexResetSnapshot(wrap({ accountEmail: "user@example.com", planType: "pro", resetCredits }))).toBeNull();
  });
});

describe("Codex launcher selection", () => {
  const files = (...paths: string[]) => (path: string) => paths.includes(path);

  it("keeps the direct PATH launch outside Windows", () => {
    expect(codexLaunch("linux", { PATH: "/usr/bin" }, () => false)).toEqual({ command: "codex", args: ["app-server"] });
    expect(codexLaunch("darwin", {}, () => false)).toEqual({ command: "codex", args: ["app-server"] });
  });

  it("runs a native executable directly and an npm shim through cmd.exe with fixed quoting", () => {
    const env = { Path: "C:\\Tools;\"C:\\Program Files\\nodejs\\\";C:\\Users\\Me\\AppData\\Roaming\\npm\\", PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1" };
    expect(codexLaunch("win32", env, files("C:\\Program Files\\nodejs\\codex.exe", "C:\\Users\\Me\\AppData\\Roaming\\npm\\codex.cmd")))
      .toEqual({ command: "C:\\Program Files\\nodejs\\codex.exe", args: ["app-server"] });
    expect(codexLaunch("win32", { ...env, ComSpec: "C:\\Windows\\system32\\cmd.exe" }, files("C:\\Users\\Me\\AppData\\Roaming\\npm\\codex.cmd"))).toEqual({
      command: "C:\\Windows\\system32\\cmd.exe",
      args: ["/d", "/s", "/c", "\"\"C:\\Users\\Me\\AppData\\Roaming\\npm\\codex.cmd\" app-server\""],
      windowsVerbatimArguments: true,
    });
  });

  it("follows PATHEXT order within a directory and never launches scripts it cannot quote safely", () => {
    const both = files("C:\\npm\\codex.cmd", "C:\\npm\\codex.exe");
    expect(codexLaunch("win32", { PATH: "C:\\npm", PATHEXT: ".CMD;.EXE" }, both)?.command).toBe("cmd.exe");
    expect(codexLaunch("win32", { PATH: "C:\\npm" }, both)?.command).toBe("C:\\npm\\codex.exe");
    expect(codexLaunch("win32", { PATH: "C:\\npm", PATHEXT: ".PS1;.JS" }, both)).toBeNull();
    expect(codexLaunch("win32", { PATH: "C:\\npm", ComSpec: "cmd & calc.exe" }, files("C:\\npm\\codex.cmd"))?.command).toBe("cmd.exe");
    expect(codexLaunch("win32", { PATH: "npm;C:\\%USERPROFILE%\\npm" }, () => true)).toBeNull();
    expect(codexLaunch("win32", {}, () => true)).toBeNull();
  });
});

describe("Codex collector cleanup through a launcher", () => {
  // Stands in for cmd.exe running the npm shim: killing the wrapper leaves the
  // server alive and holding the pipes, and the server ignores stdin closing.
  async function collectThroughWrapper(respond: boolean) {
    const bin = await mkdtemp(join(tmpdir(), "bb-codex-wrapper-"));
    dirs.push(bin);
    const pidFile = join(bin, "server.pid");
    await symlink(process.execPath, join(bin, "node"));
    await writeFile(join(bin, "server.js"), `
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id == null || !${respond}) return;
  const result = request.method === 'account/read' ? { account: { type: 'chatgpt', email: 'user@example.com', planType: 'pro' } }
    : request.method === 'account/rateLimits/read' ? { rateLimitResetCredits: { availableCount: 1, credits: null } } : {};
  console.log(JSON.stringify({ id: request.id, result }));
});
`);
    await writeFile(join(bin, "codex"), `#!/bin/sh\n"${bin}/node" "${bin}/server.js"\n`, { mode: 0o755 });
    const started = Date.now();
    try {
      const { stdout } = await run("/bin/sh", ["-c", codexResetsCommand()], {
        env: { ...process.env, PATH: `${bin}:/bin:/usr/bin`, NODE_OPTIONS: "" }, timeout: 20_000,
      });
      return { stdout, elapsed: Date.now() - started };
    } finally {
      const pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
      if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }

  it("exits promptly after success even when the wrapped server keeps its pipes open", async () => {
    const { stdout, elapsed } = await collectThroughWrapper(true);
    expect(parseCodexResetSnapshot(stdout)?.resetCredits).toEqual({ availableCount: 1, credits: null });
    expect(elapsed).toBeLessThan(5_000);
  });

  it("exits at the request timeout when the wrapped server never answers", async () => {
    const { stdout, elapsed } = await collectThroughWrapper(false);
    expect(stdout).toBe("");
    expect(elapsed).toBeLessThan(14_000);
  }, 20_000);
});
