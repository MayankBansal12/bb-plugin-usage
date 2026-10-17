import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { codexResetsCommand, parseCodexResetSnapshot } from "./codex-resets";

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
