import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grokLimitsCommand, normalizeGrokBilling } from "./grok-limits";

describe("Grok billing", () => {
  it("prefers unified weekly percentage and reset over legacy monthly fields", () => {
    expect(normalizeGrokBilling({ config: {
      creditUsagePercent: 42, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-09-12T00:00:00Z" },
      monthlyLimit: { val: 100 }, used: { val: 99 }, isUnifiedBillingUser: true,
    } })).toEqual([{ label: "Weekly (shared credits)", usedPercent: 42, resetsAt: "2026-09-12T00:00:00.000Z" }]);
  });
  it("supports legacy cents, protobuf string integers, and on-demand caps", () => {
    expect(normalizeGrokBilling({ config: { monthlyLimit: { val: "1000" }, used: { val: "1200" }, onDemandCap: { val: 500 }, onDemandUsed: {} } })).toEqual([
      { label: "Monthly credits", usedPercent: 100, resetsAt: null },
      { label: "On-demand", usedPercent: 0, resetsAt: null, cost: { usedUsdCents: 0, limitUsdCents: 500 } },
    ]);
  });
  it("distinguishes no plan from malformed or missing usage", () => {
    expect(normalizeGrokBilling({ config: null })).toEqual([]);
    for (const config of [{}, { creditUsagePercent: "42" }, { creditUsagePercent: -1 }, { monthlyLimit: { val: "oops" } }]) {
      expect(() => normalizeGrokBilling({ config })).toThrow();
    }
    expect(() => normalizeGrokBilling({})).toThrow();
  });
  it("runs on the host and emits only normalized limits and an account hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-limits-test-"));
    try {
      const authPath = join(dir, "auth.json");
      writeFileSync(authPath, JSON.stringify({ "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": { key: "test-secret", user_id: "test-user", auth_mode: "oidc" } }));
      const preload = join(dir, "fetch.cjs");
      writeFileSync(preload, `global.fetch = async (url, options) => {
        if (url !== 'https://cli-chat-proxy.grok.com/v1/billing?format=credits' || options.headers.Authorization !== 'Bearer test-secret' || options.headers['x-userid'] !== 'test-user' || options.redirect !== 'error') throw Error('Bad request');
        return new Response(JSON.stringify({ config: { creditUsagePercent: 25, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' } }, secret: 'must-not-transfer' }));
      };`);
      const output = execFileSync("bash", ["-c", grokLimitsCommand()], { encoding: "utf8", env: { ...process.env, GROK_AUTH_PATH: authPath, NODE_OPTIONS: `--require=${preload}` } });
      expect(output).toContain('"usedPercent":25');
      expect(output).not.toMatch(/test-secret|test-user|must-not-transfer/);
      expect(output).toMatch(/"accountIdentity":"[a-f0-9]{64}"/);
      rmSync(authPath);
      expect(execFileSync("bash", ["-c", grokLimitsCommand()], { encoding: "utf8", env: { ...process.env, GROK_AUTH_PATH: authPath } })).toContain("no-grok-credential");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
