import { gunzipSync, gzipSync } from "node:zlib";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { describe, expect, it, vi } from "vitest";
import plugin, { openCodeCommand } from "./server";
import { createCommandHostEntry } from "./host";
import { openCodeGoUsageCommand } from "./lib/opencode-go";

const agents = ["codex", "claude", "fx", "grok", "pi", "prime", "antigravity", "opencode"];
function agentFor(command: string): string {
  if (command === openCodeCommand()) return "opencode";
  if (command === openCodeGoUsageCommand()) return "opencode-go";
  const outer = command.match(/Buffer\.from\("([A-Za-z0-9+/=]+)"/);
  if (!outer) throw new Error("Unexpected collector command");
  const script = gunzipSync(Buffer.from(outer[1]!, "base64")).toString();
  const inner = script.match(/\}\)\("([A-Za-z0-9+/=]+)"/);
  if (!inner) throw new Error("Missing collector input");
  return JSON.parse(Buffer.from(inner[1]!, "base64").toString()).agentId;
}
function outputFor(agent: string, percent: number) {
  if (agent === "opencode-go") return `__BB_GO_FINGERPRINT__:${"a".repeat(64)}\n__BB_USAGE_BEGIN__\n${JSON.stringify({ usage: { rolling: { status: "ok", percent } } })}\n__BB_USAGE_END__:0\n`;
  const row = {
    day: new Date().toISOString().slice(0, 10), modelProviderId: "anthropic", model: "claude-sonnet-4",
    project: "fixture", loggedCostUsd: 0.25, uncachedInputTokens: 100,
    inputTokens: 100, cachedInputTokens: 20, cacheWriteTokens: 5, outputTokens: 10, reasoningTokens: 0,
  };
  if (agent === "opencode") return `__BB_USAGE_BEGIN__\n${JSON.stringify([row])}\n__BB_USAGE_END__:0\n`;
  const scan = { agentId: agent, fileCount: 1, changedFileCount: 1, reusedFileCount: 0, failureCount: 0, error: null, rows: [row] };
  return `__BB_USAGE_SCAN_BEGIN__\n${gzipSync(JSON.stringify(scan)).toString("base64")}\n__BB_USAGE_SCAN_END__\n`;
}
function quote(value: string) { return "'" + value.replaceAll("'", "'\"'\"'") + "'"; }
type Dashboard = {
  records: Array<{ machineId: string; agentId: string; processedTokens: number; costUsd: number }>;
  sources: Array<{ machineId: string; agentId: string; status: string; recordCount: number }>;
  sync: { running: boolean };
};
type Limit = {
  providerId: string; status: string; windows: Array<{ usedPercent: number }>;
  machines: Array<{ machineId: string; status: string }>;
};

describe("usage refresh compatibility through host workers", () => {
  it("preserves all collectors, totals, subscription grouping, and saved data across failed refreshes", async () => {
    const workers = new Map(["host-1", "host-2"].map(id => [id, experimental_createHostEntryHarness(createCommandHostEntry())]));
    const dispatched = new Set<string>();
    let fail = false;
    let goPercent = 25;
    const { bb, harness } = createFakePluginHost({
      pluginId: "usage",
      sdk: {
        hosts: {
          list: async () => [...workers.keys()].map(id => ({ id, name: id, status: "connected" })),
          directory: async () => ({ directory: "/fixture-home" }),
        },
        system: {
          usageLimits: async ({ hostId }: { hostId: string }) => Object.fromEntries(
            ["codex", "claude-code", "acp-cursor"].map(id => [id, {
              status: "ok", planLabel: "Pro", accountEmail: "fixture@example.com",
              windows: [{ label: "5 hours", usedPercent: hostId === "host-1" ? 30 : 32, resetsAt: null }],
            }]),
          ),
        },
      },
      experimental_callHostRpc: async ({ hostId, method, input, signal }) => {
        const worker = workers.get(hostId)!;
        if (method === "cancel") return worker.experimental_call("cancel", input, { signal });
        const request = input as { id: string; command: string; timeoutMs: number };
        const agent = agentFor(request.command);
        dispatched.add(`${hostId}/${agent}`);
        // Only external collector output is substituted. The plugin orchestration,
        // shell processes, host job lifecycle, schemas, SQLite and dashboard RPCs are real.
        const command = fail && ["codex", "opencode", "opencode-go"].includes(agent)
          ? "printf 'fixture query failed' >&2; exit 7"
          : `printf '%s' ${quote(outputFor(agent, goPercent))}`;
        return worker.experimental_call("run", { ...request, command }, { signal });
      },
    });
    const dashboard = async () => await harness.behavior.callRpc("dashboard", null) as Dashboard;
    const limits = async () => await harness.behavior.callRpc("providerLimits", null) as Limit[];
    const refresh = async () => {
      await harness.behavior.callRpc("sync", null);
      await vi.waitFor(async () => expect((await dashboard()).sync.running).toBe(false), { timeout: 5000 });
    };
    try {
      await plugin(bb);
      await refresh();
      expect([...dispatched].sort()).toEqual([...workers.keys()].flatMap(host => [...agents, "opencode-go"].map(agent => `${host}/${agent}`)).sort());
      const initial = await dashboard();
      expect(initial.records).toHaveLength(16);
      expect(initial.records.reduce((sum, row) => sum + row.processedTokens, 0)).toBe(2160);
      expect(initial.records.every(row => Number.isFinite(row.costUsd) && row.costUsd >= 0)).toBe(true);
      expect(initial.sources.every(source => source.status === "ready" && source.recordCount === 1)).toBe(true);
      const initialLimits = await limits();
      expect(initialLimits.map(limit => limit.providerId).sort()).toEqual(["claude", "codex", "cursor", "opencode-go"]);
      for (const limit of initialLimits) {
        expect(limit.machines).toHaveLength(2);
        expect(limit.status).toBe("ok");
        expect(limit.windows[0]?.usedPercent).toBe(limit.providerId === "opencode-go" ? 25 : 32);
      }
      // Repeated refreshes must not duplicate usage or add percentages together.
      await refresh();
      expect((await dashboard()).records).toEqual(initial.records);
      expect((await limits()).map(limit => limit.windows)).toEqual(initialLimits.map(limit => limit.windows));

      fail = true;
      await refresh();
      const failed = await dashboard();
      expect(failed.records).toEqual(initial.records);
      expect(failed.sources.filter(source => ["codex", "opencode"].includes(source.agentId)).every(source => source.status === "unavailable" && source.recordCount === 1)).toBe(true);
      expect(failed.sources.filter(source => !["codex", "opencode"].includes(source.agentId)).every(source => source.status === "ready")).toBe(true);
      const failedLimits = await limits();
      expect(failedLimits.find(limit => limit.providerId === "opencode-go")).toMatchObject({ status: "error", windows: [{ usedPercent: 25 }] });
      expect(failedLimits.filter(limit => limit.providerId !== "opencode-go")).toEqual(initialLimits.filter(limit => limit.providerId !== "opencode-go"));

      fail = false;
      goPercent = 40;
      await refresh();
      expect((await dashboard()).records).toEqual(initial.records);
      expect((await dashboard()).sources.every(source => source.status === "ready")).toBe(true);
      expect((await limits()).find(limit => limit.providerId === "opencode-go")).toMatchObject({ status: "ok", windows: [{ usedPercent: 40 }] });
      for (const worker of workers.values()) expect(worker.experimental_getRetainedWorkerLeaseCount()).toBe(0);
    } finally {
      await Promise.all([...workers.values()].map(worker => worker.experimental_dispose()));
      await harness.lifecycle.dispose();
    }
  }, 20_000);
});
