import { grokLimitsMigration, syncGrokLimits, loadStoredGrokLimits } from "./server";
import Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@bb/plugin-sdk";

vi.mock("@bb/plugin-sdk", () => ({
  defineRpcContract: <T>(contract: T) => contract,
}));

import plugin, {
  dashboardRecordsSql, devinCommand, extractOpenCodeJson, jsonAgentRoots, loadProviderLimits, loadStoredOpenCodeGoLimits,
  openCodeCommand, openCodeSql, runHostCommand, syncDevin, syncOpenCode, syncOpenCodeGo,
} from "./server";

function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Same markers host-json-collector.ts's hostJsonCollector() wraps its
// gzipped result in; not exported (they're a private wire format between
// the generated host script and extractHostJsonScan), so the fixture
// reproduces them rather than importing.
const SCAN_BEGIN = "__BB_USAGE_SCAN_BEGIN__";
const SCAN_END = "__BB_USAGE_SCAN_END__";

function fakeHostScanOutput(agentId: string, rows: Array<Record<string, unknown>>) {
  const scan = { agentId, fileCount: 1, changedFileCount: 1, reusedFileCount: 0, failureCount: 0, error: null, rows };
  const encoded = gzipSync(Buffer.from(JSON.stringify(scan))).toString("base64");
  return `${SCAN_BEGIN}\n${encoded}\n${SCAN_END}\n__BB_HOST_COMMAND_DONE__:0\n`;
}

// The command is a shell wrapper around `node -e eval(gunzip(base64(...)))`
// where the gzipped payload is the generated collector script with
// agentId/roots baked in as a literal object — decode it the same way
// to tell which JSON-agent sync this particular terminal is for.
function agentIdFromCommand(command: string): string | null {
  // Outer layer: eval(gunzip(base64(<script source>))). Match only up to
  // the closing quote of the base64 argument — the rest of the call
  // (,'base64')) has its single quotes mangled by shellQuote's bash
  // escaping (' becomes '"'"') once this is embedded in the full
  // command, so anchoring on that literal text would never match here.
  const outer = command.match(/Buffer\.from\("([A-Za-z0-9+/=]+)"/);
  if (!outer) return null;
  const source = gunzipSync(Buffer.from(outer[1]!, "base64")).toString("utf8");
  // Inner layer: the collector function is invoked as
  // (function hostJsonCollector(encodedInput, dependencies) {...})("<base64 JSON>", {...}) —
  // encodedInput is JSON.stringify(input) base64'd separately from the
  // gzip layer above.
  const inner = source.match(/\}\)\("([A-Za-z0-9+/=]+)"/);
  if (!inner) return null;
  const input = JSON.parse(Buffer.from(inner[1]!, "base64").toString("utf8")) as { agentId?: string };
  return input.agentId ?? null;
}

function hostFileWriteMock(stagedFiles: Map<string, string>) {
  return vi.fn(async (args: { path: string; content: string }) => {
    stagedFiles.set(args.path, args.content);
    return {
      outcome: "written" as const,
      sha256: createHash("sha256").update(args.content).digest("hex"),
      sizeBytes: args.content.length,
    };
  });
}

// Oversized commands reach the terminal as `sh '<staged path>'`; resolve that
// back to the staged file contents before decoding which agent it belongs to.
function commandTextFor(command: string, stagedFiles: Map<string, string>) {
  const stagedPath = command.match(/sh '([^']+\.sh)'/)?.[1];
  return (stagedPath ? stagedFiles.get(stagedPath) : undefined) ?? command;
}

describe("JSON agent roots", () => {
  it("points Antigravity at the provider bridge's own usage log", () => {
    expect(jsonAgentRoots("/home/user", "antigravity", { piSessionRoots: "", primeSessionRoots: "" })).toEqual([
      "/home/user/.antigravity-acp/usage.jsonl",
    ]);
  });

  it("points DeepSeek Harness at its compressed session root", () => {
    expect(jsonAgentRoots("/home/user", "dsh", { piSessionRoots: "", primeSessionRoots: "" })).toEqual([
      "/home/user/.dsh/sessions",
    ]);
  });

  it("includes Prime root and recursive-agent sessions", () => {
    expect(jsonAgentRoots("/home/user", "prime", { piSessionRoots: "", primeSessionRoots: "" })).toEqual([
      "/home/user/.prime/agent/sessions",
      "/home/user/.prime/agent/session-artifacts",
    ]);
  });

  it("derives artifact directories for custom Prime session roots", () => {
    expect(jsonAgentRoots("/home/user", "prime", {
      piSessionRoots: "",
      primeSessionRoots: "~/prime-sessions; /var/lib/prime/sessions/",
    })).toEqual([
      "/home/user/.prime/agent/sessions",
      "/home/user/.prime/agent/session-artifacts",
      "/home/user/prime-sessions",
      "/home/user/session-artifacts",
      "/var/lib/prime/sessions",
      "/var/lib/prime/session-artifacts",
    ]);
  });

  it("includes the bb pi provider bridge session directory by default", () => {
    expect(jsonAgentRoots("/home/user", "pi", { piSessionRoots: "", primeSessionRoots: "" })).toEqual([
      "/home/user/.pi/agent/sessions",
      "/home/user/.bb/pi-bridge-sessions",
    ]);
  });

  it("moves known Prime roots out of legacy Pi extra roots", () => {
    expect(jsonAgentRoots("/home/user", "pi", {
      piSessionRoots: "~/.prime/agent; ~/.prime/agent/sessions; ~/.prime/agent/session-artifacts; /data/pi; /data/prime/sessions",
      primeSessionRoots: "/data/prime/sessions",
    })).toEqual([
      "/home/user/.pi/agent/sessions",
      "/home/user/.bb/pi-bridge-sessions",
      "/data/pi",
    ]);
  });
});

describe("sync RPC", () => {
  it("returns before a slow collection completes", async () => {
    let handlers: { sync: () => unknown } | undefined;
    const collection = new Promise<never>(() => {});
    const db = { prepare: vi.fn(() => ({ get: vi.fn() })) };
    const bb = {
      settings: { define: vi.fn() },
      storage: { database: vi.fn(() => db), migrate: vi.fn() },
      rpc: {
        register: vi.fn((_contract: unknown, registered: unknown) => {
          handlers = registered as { sync: () => unknown };
        }),
      },
      sdk: { hosts: { list: vi.fn(() => collection) } },
      realtime: { publish: vi.fn() },
      background: { service: vi.fn() },
      log: { error: vi.fn() },
    } as unknown as BbPluginApi;

    await plugin(bb);

    expect(handlers?.sync()).toEqual({ ok: true });
    expect(bb.sdk.hosts.list).toHaveBeenCalledOnce();
  });

  it("actually dispatches an Antigravity scan through syncAll, not just through direct scan() calls", async () => {
    // Regression test for the exact gap flagged in review on
    // https://github.com/MayankBansal12/bb-plugin-usage/pull/21: AGENTS and
    // jsonAgentRoots knew about "antigravity", but syncAll()'s Promise.all
    // never called syncJsonAgent(..., "antigravity", ...), so no scan ever
    // ran for it in production even though the unit tests (which call
    // scan()/parseHostUsageAggregates directly) all passed. This drives the
    // real, unmodified plugin factory end-to-end through its public sync()
    // RPC and asserts a row actually lands in the database for Antigravity.
    const db = new Database(":memory:");
    let handlers: { sync: () => unknown } | undefined;
    const commandsByTerminalId = new Map<string, string>();
    const stagedFiles = new Map<string, string>();

    const bb = {
      settings: { define: vi.fn(() => ({ get: async () => ({ piSessionRoots: "", primeSessionRoots: "" }) })) },
      storage: {
        database: vi.fn(() => db),
        migrate: vi.fn((_db: unknown, statements: string[]) => { for (const statement of statements) db.exec(statement); }),
      },
      rpc: {
        register: vi.fn((_contract: unknown, registered: unknown) => {
          handlers = registered as { sync: () => unknown };
        }),
      },
      sdk: {
        hosts: {
          list: vi.fn(async () => [{ id: "host-1", name: "Machine", status: "connected" }]),
          directory: vi.fn(async () => ({ directory: "/home/user" })),
        },
        files: { write: hostFileWriteMock(stagedFiles) },
        terminals: {
          create: vi.fn(async (input: { start: { command: string } }) => {
            const id = `terminal-${commandsByTerminalId.size}`;
            commandsByTerminalId.set(id, input.start.command);
            return { id, status: "starting" };
          }),
          get: vi.fn(async (args: { terminalId: string }) => ({ id: args.terminalId, status: "running" })),
          output: vi.fn(async (args: { terminalId: string }) => {
            const command = commandTextFor(commandsByTerminalId.get(args.terminalId) ?? "", stagedFiles);
            const agentId = agentIdFromCommand(command);
            const text = agentId === "antigravity"
              ? fakeHostScanOutput("antigravity", [{
                day: new Date().toISOString().slice(0, 10),
                modelProviderId: "google",
                model: "gemini-4-ultra-preview",
                loggedCostUsd: null,
                uncachedInputTokens: 13814,
                cachedInputTokens: 0,
                cacheWriteTokens: 0,
                outputTokens: 53,
              }])
              : fakeHostScanOutput(agentId ?? "codex", []); // every other agent: empty, uninteresting scan
            return { chunks: [{ seq: 1, dataBase64: Buffer.from(text).toString("base64") }], truncated: false };
          }),
          close: vi.fn(async () => undefined),
        },
      },
      realtime: { publish: vi.fn() },
      background: { service: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as BbPluginApi;

    await plugin(bb);
    expect(handlers?.sync()).toEqual({ ok: true });

    await vi.waitFor(() => {
      const row = db.prepare("SELECT provider_id FROM usage_events WHERE provider_id = 'antigravity'").get();
      expect(row).toBeTruthy();
    }, { timeout: 2000 });

    const syncState = db.prepare(
      "SELECT status, record_count recordCount FROM usage_sync_state WHERE machine_id = 'host-1' AND provider_id = 'antigravity'",
    ).get();
    expect(syncState).toEqual({ status: "ready", recordCount: 1 });

    // The terminal contract caps start.command at 10,000 characters; every
    // collector command must fit, whether inline or staged through files.write.
    for (const command of commandsByTerminalId.values()) {
      expect(command.length).toBeLessThanOrEqual(10_000);
    }

    db.close();
  });

  it("stages an oversized collector script through files.write and still records its rows", async () => {
    // A huge configured session root inflates the serialized scan input enough
    // that the compressed collector command no longer fits the terminal's
    // 10,000-character limit, forcing the files.write staging path.
    const db = new Database(":memory:");
    let handlers: { sync: () => unknown } | undefined;
    const commandsByTerminalId = new Map<string, string>();
    const stagedFiles = new Map<string, string>();
    const write = hostFileWriteMock(stagedFiles);

    const bb = {
      settings: {
        define: vi.fn(() => ({
          get: async () => ({ piSessionRoots: `/data/${randomBytes(6_000).toString("hex")}`, primeSessionRoots: "" }),
        })),
      },
      storage: {
        database: vi.fn(() => db),
        migrate: vi.fn((_db: unknown, statements: string[]) => { for (const statement of statements) db.exec(statement); }),
      },
      rpc: {
        register: vi.fn((_contract: unknown, registered: unknown) => {
          handlers = registered as { sync: () => unknown };
        }),
      },
      sdk: {
        hosts: {
          list: vi.fn(async () => [{ id: "host-1", name: "Machine", status: "connected" }]),
          directory: vi.fn(async () => ({ directory: "/home/user" })),
        },
        files: { write },
        terminals: {
          create: vi.fn(async (input: { start: { command: string } }) => {
            const id = `terminal-${commandsByTerminalId.size}`;
            commandsByTerminalId.set(id, input.start.command);
            return { id, status: "starting" };
          }),
          get: vi.fn(async (args: { terminalId: string }) => ({ id: args.terminalId, status: "running" })),
          output: vi.fn(async (args: { terminalId: string }) => {
            const command = commandTextFor(commandsByTerminalId.get(args.terminalId) ?? "", stagedFiles);
            const agentId = agentIdFromCommand(command);
            const text = agentId === "pi"
              ? fakeHostScanOutput("pi", [{
                day: new Date().toISOString().slice(0, 10),
                modelProviderId: "google",
                model: "gemini-2.5-pro",
                loggedCostUsd: null,
                uncachedInputTokens: 100,
                cachedInputTokens: 0,
                cacheWriteTokens: 0,
                outputTokens: 10,
              }])
              : fakeHostScanOutput(agentId ?? "codex", []);
            return { chunks: [{ seq: 1, dataBase64: Buffer.from(text).toString("base64") }], truncated: false };
          }),
          close: vi.fn(async () => undefined),
        },
      },
      realtime: { publish: vi.fn() },
      background: { service: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as BbPluginApi;

    await plugin(bb);
    expect(handlers?.sync()).toEqual({ ok: true });

    await vi.waitFor(() => {
      const row = db.prepare("SELECT provider_id FROM usage_events WHERE provider_id = 'pi'").get();
      expect(row).toBeTruthy();
    }, { timeout: 2000 });

    expect(write).toHaveBeenCalled();
    for (const command of commandsByTerminalId.values()) {
      expect(command.length).toBeLessThanOrEqual(10_000);
    }
    const stagedPaths = [...stagedFiles.keys()];
    expect(stagedPaths.every((path) => path.startsWith("/home/user/.cache/bb-plugin-usage/host-command-"))).toBe(true);

    const syncState = db.prepare(
      "SELECT status, record_count recordCount FROM usage_sync_state WHERE machine_id = 'host-1' AND provider_id = 'pi'",
    ).get();
    expect(syncState).toEqual({ status: "ready", recordCount: 1 });

    db.close();
  });

  it("actually dispatches a DeepSeek Harness scan through syncAll, not just through direct scan() calls", async () => {
    // Same wiring regression shape as the Antigravity test above: the agent
    // must reach syncAll()'s Promise.all, not just AGENTS/jsonAgentRoots.
    const db = new Database(":memory:");
    let handlers: { sync: () => unknown } | undefined;
    const commandsByTerminalId = new Map<string, string>();
    const stagedFiles = new Map<string, string>();

    const bb = {
      settings: { define: vi.fn(() => ({ get: async () => ({ piSessionRoots: "", primeSessionRoots: "" }) })) },
      storage: {
        database: vi.fn(() => db),
        migrate: vi.fn((_db: unknown, statements: string[]) => { for (const statement of statements) db.exec(statement); }),
      },
      rpc: {
        register: vi.fn((_contract: unknown, registered: unknown) => {
          handlers = registered as { sync: () => unknown };
        }),
      },
      sdk: {
        hosts: {
          list: vi.fn(async () => [{ id: "host-1", name: "Machine", status: "connected" }]),
          directory: vi.fn(async () => ({ directory: "/home/user" })),
        },
        files: { write: hostFileWriteMock(stagedFiles) },
        terminals: {
          create: vi.fn(async (input: { start: { command: string } }) => {
            const id = `terminal-${commandsByTerminalId.size}`;
            commandsByTerminalId.set(id, input.start.command);
            return { id, status: "starting" };
          }),
          get: vi.fn(async (args: { terminalId: string }) => ({ id: args.terminalId, status: "running" })),
          output: vi.fn(async (args: { terminalId: string }) => {
            const command = commandTextFor(commandsByTerminalId.get(args.terminalId) ?? "", stagedFiles);
            const agentId = agentIdFromCommand(command);
            const text = agentId === "dsh"
              ? fakeHostScanOutput("dsh", [{
                day: new Date().toISOString().slice(0, 10),
                modelProviderId: "deepseek",
                model: "deepseek-v4-pro",
                loggedCostUsd: null,
                uncachedInputTokens: 100,
                cachedInputTokens: 0,
                cacheWriteTokens: 0,
                outputTokens: 20,
              }])
              : fakeHostScanOutput(agentId ?? "codex", []); // every other agent: empty, uninteresting scan
            return { chunks: [{ seq: 1, dataBase64: Buffer.from(text).toString("base64") }], truncated: false };
          }),
          close: vi.fn(async () => undefined),
        },
      },
      realtime: { publish: vi.fn() },
      background: { service: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as BbPluginApi;

    await plugin(bb);
    expect(handlers?.sync()).toEqual({ ok: true });

    await vi.waitFor(() => {
      const row = db.prepare("SELECT provider_id FROM usage_events WHERE provider_id = 'dsh'").get();
      expect(row).toBeTruthy();
    }, { timeout: 2000 });

    const syncState = db.prepare(
      "SELECT status, record_count recordCount FROM usage_sync_state WHERE machine_id = 'host-1' AND provider_id = 'dsh'",
    ).get();
    expect(syncState).toEqual({ status: "ready", recordCount: 1 });

    db.close();
  });

  it("collects Codex profile accounts as separate dashboard agents", async () => {
    const db = new Database(":memory:");
    let handlers: {
      sync: () => unknown;
      dashboard: () => Promise<{
        agents: Array<{ id: string; name: string }>;
        records: Array<{ agentId: string; agentName: string; processedTokens: number }>;
      }>;
    } | undefined;

    // Decode the generated collector script's baked-in scan input so the test
    // can answer codex scans with profile-tagged rows and assert the scan
    // covers the account root.
    function scanInputFromCommand(command: string): { agentId?: string; roots?: string[]; accountRoot?: string } | null {
      const outer = command.match(/Buffer\.from\("([A-Za-z0-9+/=]+)"/);
      if (!outer) return null;
      const source = gunzipSync(Buffer.from(outer[1]!, "base64")).toString("utf8");
      const inner = source.match(/\}\)\("([A-Za-z0-9+/=]+)"/);
      if (!inner) return null;
      return JSON.parse(Buffer.from(inner[1]!, "base64").toString("utf8"));
    }

    const commandsByTerminalId = new Map<string, string>();
    const stagedFiles = new Map<string, string>();
    const day = new Date().toISOString().slice(0, 10);
    const aggregateRow = (account?: string) => ({
      day,
      modelProviderId: "openai",
      model: "gpt-5.6-sol",
      project: "app",
      ...(account === undefined ? {} : { account }),
      loggedCostUsd: null,
      uncachedInputTokens: 40,
      cachedInputTokens: 60,
      cacheWriteTokens: 5,
      outputTokens: 20,
    });

    const bb = {
      settings: { define: vi.fn(() => ({ get: async () => ({ piSessionRoots: "", primeSessionRoots: "" }) })) },
      storage: {
        database: vi.fn(() => db),
        migrate: vi.fn((_db: unknown, statements: string[]) => { for (const statement of statements) db.exec(statement); }),
      },
      rpc: {
        register: vi.fn((_contract: unknown, registered: unknown) => {
          handlers = registered as typeof handlers;
        }),
      },
      sdk: {
        hosts: {
          list: vi.fn(async () => [{ id: "host-1", name: "Machine", status: "connected" }]),
          directory: vi.fn(async () => ({ directory: "/home/user" })),
        },
        files: { write: hostFileWriteMock(stagedFiles) },
        terminals: {
          create: vi.fn(async (input: { start: { command: string } }) => {
            const id = `terminal-${commandsByTerminalId.size}`;
            commandsByTerminalId.set(id, input.start.command);
            return { id, status: "starting" };
          }),
          get: vi.fn(async (args: { terminalId: string }) => ({ id: args.terminalId, status: "running" })),
          output: vi.fn(async (args: { terminalId: string }) => {
            const command = commandTextFor(commandsByTerminalId.get(args.terminalId) ?? "", stagedFiles);
            const input = scanInputFromCommand(command);
            const text = input?.agentId === "codex"
              ? fakeHostScanOutput("codex", [aggregateRow(), aggregateRow("saiens")])
              : fakeHostScanOutput(input?.agentId ?? "codex", []);
            return { chunks: [{ seq: 1, dataBase64: Buffer.from(text).toString("base64") }], truncated: false };
          }),
          close: vi.fn(async () => undefined),
        },
      },
      realtime: { publish: vi.fn() },
      background: { service: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as BbPluginApi;

    await plugin(bb);
    expect(handlers?.sync()).toEqual({ ok: true });

    await vi.waitFor(() => {
      expect(db.prepare("SELECT COUNT(*) count FROM usage_events").get()).toEqual({ count: 2 });
    }, { timeout: 2000 });

    const codexScan = [...commandsByTerminalId.values()]
      .map((command) => scanInputFromCommand(commandTextFor(command, stagedFiles)))
      .find((input) => input?.agentId === "codex");
    expect(codexScan).toMatchObject({
      roots: ["/home/user/.codex/sessions"],
      accountRoot: "/home/user/.codex-profiles",
    });

    const providers = db.prepare(
      "SELECT provider_id, provider_name FROM usage_events ORDER BY provider_id",
    ).all();
    expect(providers).toEqual([
      { provider_id: "codex", provider_name: "Codex" },
      { provider_id: "codex-saiens", provider_name: "Codex (saiens)" },
    ]);
    expect(db.prepare(
      "SELECT status, record_count recordCount FROM usage_sync_state WHERE machine_id = 'host-1' AND provider_id = 'codex'",
    ).get()).toEqual({ status: "ready", recordCount: 2 });

    const dashboard = await handlers!.dashboard();
    expect(dashboard.agents).toEqual(expect.arrayContaining([
      { id: "codex", name: "Codex" },
      { id: "codex-saiens", name: "Codex (saiens)" },
    ]));
    expect(dashboard.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: "codex", agentName: "Codex", processedTokens: 125 }),
      expect.objectContaining({ agentId: "codex-saiens", agentName: "Codex (saiens)", processedTokens: 125 }),
    ]));

    db.close();
  });
});

describe("provider limit loading", () => {
  function emptyDb() {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE usage_sources (source_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, machine_name TEXT NOT NULL, provider_id TEXT NOT NULL);
      CREATE TABLE usage_event_sources (event_key TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY (event_key, source_id));
    `);
    return db;
  }

  it("does not block the dashboard when a connected machine stalls", async () => {
    const usageLimits = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const debug = vi.fn();
    const bb = {
      sdk: { system: { usageLimits } },
      log: { debug },
    } as unknown as BbPluginApi;

    await expect(loadProviderLimits(bb, [
      { id: "host_1", name: "Slow machine", status: "connected" },
    ], emptyDb(), 10)).resolves.toEqual([]);
    expect(usageLimits).toHaveBeenCalledWith({ hostId: "host_1", signal: expect.any(AbortSignal) });
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("Provider limits unavailable"));
  });

  it("keeps limits returned by responsive machines", async () => {
    const usageLimits = vi.fn(async (_args: { hostId: string; signal: AbortSignal }) => ({
      codex: {
        status: "ok",
        planLabel: "Pro",
        windows: [{ label: "5 hours", usedPercent: 42, resetsAt: null }],
      },
      claudeCode: { status: "unavailable", planLabel: null, windows: [] },
      cursor: { status: "unavailable", planLabel: null, windows: [] },
    }));
    const bb = {
      sdk: { system: { usageLimits } },
      log: { debug: vi.fn() },
    } as unknown as BbPluginApi;

    await expect(loadProviderLimits(bb, [
      { id: "host_1", name: "Fast machine", status: "connected" },
    ], emptyDb(), 1_000)).resolves.toEqual([expect.objectContaining({
      machineId: "host_1",
      providerId: "codex",
      planLabel: "Pro",
      status: "ok",
    })]);
  });

  it("uses current provider ids and ignores providers omitted from the response", async () => {
    const usageLimits = vi.fn(async () => ({
      codex: {
        status: "ok",
        planLabel: "Plus",
        accountEmail: null,
        windows: [{ label: "5 hours", usedPercent: 20, resetsAt: null }],
      },
      "claude-code": {
        status: "ok",
        planLabel: "Max",
        accountEmail: null,
        windows: [{ label: "5 hours", usedPercent: 30, resetsAt: null }],
      },
      "acp-cursor": {
        status: "ok",
        planLabel: "Pro",
        accountEmail: null,
        windows: [{ label: "Monthly", usedPercent: 40, resetsAt: null }],
      },
    }));
    const bb = {
      sdk: { system: { usageLimits } },
      log: { debug: vi.fn() },
    } as unknown as BbPluginApi;

    await expect(loadProviderLimits(bb, [
      { id: "host_1", name: "Current machine", status: "connected" },
    ], emptyDb(), 1_000)).resolves.toEqual([
      expect.objectContaining({ providerId: "codex", status: "ok" }),
      expect.objectContaining({ providerId: "claude", status: "ok" }),
      expect.objectContaining({ providerId: "cursor", status: "ok" }),
    ]);
  });

  it("surfaces a provider error (e.g. rate limited) instead of hiding the provider", async () => {
    const usageLimits = vi.fn(async () => ({
      codex: { status: "ok", planLabel: "Pro", windows: [{ label: "5 hours", usedPercent: 10, resetsAt: null }] },
      claudeCode: { status: "error", message: "rate limited", planLabel: null, accountEmail: null },
      cursor: { status: "not_installed" },
    }));
    const debug = vi.fn();
    const bb = {
      sdk: { system: { usageLimits } },
      log: { debug },
    } as unknown as BbPluginApi;

    await expect(loadProviderLimits(bb, [
      { id: "host_1", name: "Fast machine", status: "connected" },
    ], emptyDb(), 1_000)).resolves.toEqual([
      expect.objectContaining({ providerId: "codex", status: "ok" }),
      expect.objectContaining({ providerId: "claude", status: "error", error: "rate limited" }),
    ]);
  });

  it("surfaces an error for providers with usage records when the whole limits call fails", async () => {
    const usageLimits = vi.fn(async () => { throw new Error("rate limited"); });
    const debug = vi.fn();
    const bb = {
      sdk: { system: { usageLimits } },
      log: { debug },
    } as unknown as BbPluginApi;

    const db = emptyDb();
    db.prepare("INSERT INTO usage_sources (source_id, machine_id, machine_name, provider_id) VALUES (?, ?, ?, ?)")
      .run("claude-source", "host_1", "Fast machine", "claude");
    db.prepare("INSERT INTO usage_event_sources (event_key, source_id) VALUES (?, ?)")
      .run("event-1", "claude-source");

    await expect(loadProviderLimits(bb, [
      { id: "host_1", name: "Fast machine", status: "connected" },
    ], db, 1_000)).resolves.toEqual([expect.objectContaining({
      machineId: "host_1",
      providerId: "claude",
      status: "error",
    })]);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("Provider limits unavailable"));
  });

  it("queries connected machines concurrently", async () => {
    let activeCalls = 0;
    let maxActiveCalls = 0;
    const usageLimits = vi.fn(async ({ hostId }: { hostId: string }) => {
      activeCalls += 1;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeCalls -= 1;
      return {
        "claude-code": {
          status: "ok",
          planLabel: "Max",
          accountEmail: "dev@example.com",
          windows: [{ label: "5 hours", usedPercent: hostId === "host_1" ? 30 : 32, resetsAt: null }],
        },
      };
    });
    const bb = {
      sdk: { system: { usageLimits } },
      log: { debug: vi.fn() },
    } as unknown as BbPluginApi;

    const sources = await loadProviderLimits(bb, [
      { id: "host_1", name: "Studio", status: "connected" },
      { id: "host_2", name: "Air", status: "connected" },
    ], emptyDb(), 1_000);
    expect(sources).toHaveLength(2);
    expect(maxActiveCalls).toBe(2);
    expect(usageLimits.mock.calls.map((call) => call[0].hostId)).toEqual(["host_1", "host_2"]);
  });
});

describe("host command output", () => {
  it("collects output while the terminal is still running, then closes it", async () => {
    const text = "query result\n__BB_HOST_COMMAND_DONE__:0\n";
    const create = vi.fn(async (input: unknown) => ({ id: "terminal-1", status: "starting", input }));
    const get = vi.fn(async () => ({ id: "terminal-1", status: "running" }));
    const output = vi.fn(async () => ({
      chunks: [{ seq: 1, dataBase64: Buffer.from(text).toString("base64") }],
      truncated: false,
    }));
    const close = vi.fn(async () => undefined);
    const bb = { sdk: { terminals: { create, get, output, close } } } as unknown as BbPluginApi;

    await expect(runHostCommand(
      bb,
      { id: "host-1", name: "Machine" },
      "printf result",
      new AbortController().signal,
      { title: "Usage test", timeoutMs: 1_000, pollMs: 1 },
    )).resolves.toBe(text);

    expect(get).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith({ terminalId: "terminal-1", mode: "force" });
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      start: { mode: "command", command: expect.stringContaining("__BB_HOST_COMMAND_DONE__") },
    });
  });

  it("surfaces a command diagnostic before closing the held terminal", async () => {
    const text = "__BB_USAGE_ERROR__:OpenCode query failed\n__BB_HOST_COMMAND_DONE__:1\n";
    const close = vi.fn(async () => undefined);
    const bb = {
      sdk: { terminals: {
        create: vi.fn(async () => ({ id: "terminal-1", status: "starting" })),
        get: vi.fn(async () => ({ id: "terminal-1", status: "running" })),
        output: vi.fn(async () => ({ chunks: [{ seq: 1, dataBase64: Buffer.from(text).toString("base64") }], truncated: false })),
        close,
      } },
    } as unknown as BbPluginApi;

    await expect(runHostCommand(
      bb,
      { id: "host-1", name: "Machine" },
      "exit 127",
      new AbortController().signal,
      { title: "Usage test", timeoutMs: 1_000, pollMs: 1 },
    )).rejects.toThrow("OpenCode query failed");
    expect(close).toHaveBeenCalledOnce();
  });

  it("surfaces bounded terminal output when a command has no structured diagnostic", async () => {
    const text = "CLI compatibility error\n__BB_HOST_COMMAND_DONE__:1\n";
    const bb = {
      sdk: { terminals: {
        create: vi.fn(async () => ({ id: "terminal-1", status: "starting" })),
        get: vi.fn(async () => ({ id: "terminal-1", status: "running" })),
        output: vi.fn(async () => ({ chunks: [{ seq: 1, dataBase64: Buffer.from(text).toString("base64") }], truncated: false })),
        close: vi.fn(async () => undefined),
      } },
    } as unknown as BbPluginApi;

    await expect(runHostCommand(
      bb,
      { id: "host-1", name: "Machine" },
      "exit 1",
      new AbortController().signal,
      { title: "Usage test", timeoutMs: 1_000, pollMs: 1 },
    )).rejects.toThrow("CLI compatibility error");
  });

  it("times out and closes a stalled machine terminal", async () => {
    const close = vi.fn(async () => undefined);
    const bb = {
      sdk: { terminals: {
        create: vi.fn(async () => ({ id: "terminal-1", status: "starting" })),
        get: vi.fn(async () => ({ id: "terminal-1", status: "running" })),
        output: vi.fn(async () => ({ chunks: [], truncated: false })),
        close,
      } },
    } as unknown as BbPluginApi;

    await expect(runHostCommand(
      bb,
      { id: "host-1", name: "Stalled machine" },
      "opencode db query",
      new AbortController().signal,
      { title: "Usage test", timeoutMs: 1, pollMs: 1 },
    )).rejects.toThrow("timed out");
    expect(close).toHaveBeenCalledWith({ terminalId: "terminal-1", mode: "force" });
  });

  function stagedRun(text: string, overrides: { write?: unknown; directory?: unknown } = {}) {
    const stagedFiles = new Map<string, string>();
    const create = vi.fn(async (input: { start: { command: string } }) => ({ id: "terminal-1", status: "starting", input }));
    const bb = {
      sdk: {
        files: { write: overrides.write ?? hostFileWriteMock(stagedFiles) },
        hosts: { directory: overrides.directory ?? vi.fn(async () => ({ directory: "/resolved/home" })) },
        terminals: {
          create,
          get: vi.fn(async () => ({ id: "terminal-1", status: "running" })),
          output: vi.fn(async () => ({
            chunks: [{ seq: 1, dataBase64: Buffer.from(text).toString("base64") }],
            truncated: false,
          })),
          close: vi.fn(async () => undefined),
        },
      },
      log: { debug: vi.fn() },
    } as unknown as BbPluginApi;
    return { bb, create, stagedFiles };
  }

  it("stages oversized commands on the host and runs them with sh", async () => {
    const command = `printf '%s' '${"x".repeat(11_000)}'`;
    const text = "scan result\n__BB_HOST_COMMAND_DONE__:0\n";
    const { bb, create, stagedFiles } = stagedRun(text);

    await expect(runHostCommand(
      bb,
      { id: "host-1", name: "Machine" },
      command,
      new AbortController().signal,
      { title: "Usage test", timeoutMs: 1_000, pollMs: 1, home: "/home/user" },
    )).resolves.toBe(text);

    const startCommand = create.mock.calls[0]![0].start.command;
    expect(startCommand.length).toBeLessThanOrEqual(10_000);
    expect(startCommand).toContain("__BB_HOST_COMMAND_DONE__");

    const stagedPaths = [...stagedFiles.keys()];
    expect(stagedPaths).toHaveLength(1);
    expect(stagedPaths[0]).toMatch(/^\/home\/user\/\.cache\/bb-plugin-usage\/host-command-[0-9a-f]{64}\.sh$/);
    expect(stagedFiles.get(stagedPaths[0]!)).toBe(command);
    expect(startCommand).toContain(`sh '${stagedPaths[0]}'`);
    expect(bb.sdk.files.write).toHaveBeenCalledWith(expect.objectContaining({
      hostId: "host-1",
      path: stagedPaths[0],
      content: command,
      createParents: true,
    }));
    expect(bb.sdk.hosts.directory).not.toHaveBeenCalled();
  });

  it("resolves the machine home directory for staging when the caller does not provide it", async () => {
    const command = `printf '%s' '${"x".repeat(11_000)}'`;
    const { bb, stagedFiles } = stagedRun("ok\n__BB_HOST_COMMAND_DONE__:0\n");

    await expect(runHostCommand(
      bb,
      { id: "host-1", name: "Machine" },
      command,
      new AbortController().signal,
      { title: "Usage test", timeoutMs: 1_000, pollMs: 1 },
    )).resolves.toContain("__BB_HOST_COMMAND_DONE__:0");

    expect(bb.sdk.hosts.directory).toHaveBeenCalledWith({ hostId: "host-1", signal: expect.any(AbortSignal) });
    expect([...stagedFiles.keys()][0]).toMatch(/^\/resolved\/home\/\.cache\/bb-plugin-usage\/host-command-/);
  });

  it.each([
    { outcome: "conflict" as const, currentSha256: "mismatch" },
    { outcome: "written" as const, sha256: "wrong", sizeBytes: 1 },
  ])("surfaces the staging error when the staged file cannot be verified (%s)", async (result) => {
    const command = `printf '%s' '${"x".repeat(11_000)}'`;
    const write = vi.fn(async () => result);
    const { bb, create } = stagedRun("unreachable\n__BB_HOST_COMMAND_DONE__:0\n", { write });

    // An oversized command cannot be submitted inline either, so the staging
    // failure is reported instead of creating a terminal the host must reject.
    await expect(runHostCommand(
      bb,
      { id: "host-1", name: "Machine" },
      command,
      new AbortController().signal,
      { title: "Usage test", timeoutMs: 1_000, pollMs: 1, home: "/home/user" },
    )).rejects.toThrow("Usage test could not stage its command on Machine: the staged command file did not verify");

    expect(create).not.toHaveBeenCalled();
  });

  it("surfaces the staging error when the host file write throws", async () => {
    const command = `printf '%s' '${"x".repeat(11_000)}'`;
    const write = vi.fn(async () => { throw new Error("host.write_file unsupported"); });
    const { bb, create } = stagedRun("unreachable\n__BB_HOST_COMMAND_DONE__:0\n", { write });

    await expect(runHostCommand(
      bb,
      { id: "host-1", name: "Machine" },
      command,
      new AbortController().signal,
      { title: "Usage test", timeoutMs: 1_000, pollMs: 1, home: "/home/user" },
    )).rejects.toThrow("Usage test could not stage its command on Machine: host.write_file unsupported");

    expect(create).not.toHaveBeenCalled();
  });

  it("surfaces staged command diagnostics and exit codes identically", async () => {
    const command = `printf '%s' '${"x".repeat(11_000)}'`;
    const { bb } = stagedRun("__BB_USAGE_ERROR__:collector broke\n__BB_HOST_COMMAND_DONE__:1\n");

    await expect(runHostCommand(
      bb,
      { id: "host-1", name: "Machine" },
      command,
      new AbortController().signal,
      { title: "Usage test", timeoutMs: 1_000, pollMs: 1, home: "/home/user" },
    )).rejects.toThrow("collector broke");
  });

  it("keeps commands under the limit inline without touching the files API", async () => {
    const write = vi.fn();
    const { bb } = stagedRun("small\n__BB_HOST_COMMAND_DONE__:0\n", { write });

    await expect(runHostCommand(
      bb,
      { id: "host-1", name: "Machine" },
      "printf small",
      new AbortController().signal,
      { title: "Usage test", timeoutMs: 1_000, pollMs: 1 },
    )).resolves.toContain("small");
    expect(write).not.toHaveBeenCalled();
  });
});

describe("OpenCode query", () => {
  it("uses the OpenCode CLI for a 90-day aggregate without sqlite3", () => {
    const command = openCodeCommand();
    expect(command).toContain("command -v opencode");
    expect(command).toContain("opencode db");
    expect(command).toContain("--format json");
    expect(command).toContain("bb_usage_query_status=$?");
    expect(command).not.toMatch(/(?:^|; )status=\$\?/);
    expect(command).not.toContain("sqlite3");
    expect(command).toContain("time_created >= CAST(strftime");
    expect(command).toContain("-89 days");
    expect(command).not.toContain("-365 days");
    expect(command).toContain("WITH recent_sessions AS MATERIALIZED");
    expect(command).toContain("FROM session");
    expect(command).toContain("JOIN message m ON m.session_id = rs.id");
    expect(command).toContain("time_updated >= CAST(strftime");
    expect(command).toContain("$.role");
    expect(command).toContain("assistant");
    expect(command).toContain("$.tokens.cache.read");
  });

  it("rejects failed and incomplete OpenCode query output", () => {
    expect(() => extractOpenCodeJson("no markers")).toThrow("incomplete output");
    expect(() => extractOpenCodeJson("__BB_USAGE_BEGIN__\n[]\n__BB_USAGE_END__:1")).toThrow("failed with code 1");
  });

  it("retains prior usage and isolates a failed OpenCode query to its source state", async () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE usage_events (event_key TEXT PRIMARY KEY);
      CREATE TABLE usage_sources (
        source_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, machine_name TEXT NOT NULL, provider_id TEXT NOT NULL
      );
      CREATE TABLE usage_event_sources (event_key TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY (event_key, source_id));
      CREATE TABLE usage_sync_state (
        machine_id TEXT NOT NULL, provider_id TEXT NOT NULL, status TEXT NOT NULL, last_attempt_at TEXT,
        last_success_at TEXT, record_count INTEGER NOT NULL DEFAULT 0, error TEXT, PRIMARY KEY (machine_id, provider_id)
      );
      INSERT INTO usage_events (event_key) VALUES ('existing-event');
      INSERT INTO usage_sources (source_id, machine_id, machine_name, provider_id)
        VALUES ('existing-source', 'host-1', 'Machine', 'opencode');
      INSERT INTO usage_event_sources (event_key, source_id) VALUES ('existing-event', 'existing-source');
    `);
    const warn = vi.fn();
    const info = vi.fn();
    const bb = { log: { warn, info } } as unknown as BbPluginApi;

    await expect(syncOpenCode(
      bb,
      db as unknown as ReturnType<BbPluginApi["storage"]["database"]>,
      { id: "host-1", name: "Machine" },
      new AbortController().signal,
      async () => { throw new Error("query stalled"); },
    )).resolves.toBeUndefined();

    expect(db.prepare("SELECT COUNT(*) count FROM usage_events").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT status, record_count recordCount, error FROM usage_sync_state").get()).toEqual({
      status: "unavailable", recordCount: 1, error: "query stalled",
    });
    expect(warn).toHaveBeenCalledWith("Machine/opencode: query stalled");

    await expect(syncOpenCode(
      bb,
      db as unknown as ReturnType<BbPluginApi["storage"]["database"]>,
      { id: "host-1", name: "Machine" },
      new AbortController().signal,
      async () => { throw new Error("OpenCode CLI is required to collect OpenCode usage."); },
    )).resolves.toBeUndefined();

    expect(db.prepare("SELECT status, record_count recordCount, error FROM usage_sync_state").get()).toEqual({
      status: "skipped",
      recordCount: 1,
      error: "OpenCode CLI is not installed; hosted OpenCode Go usage is already collected via Prime Agent sessions.",
    });
    expect(info).toHaveBeenCalledWith("Machine/opencode: skipped (no local OpenCode CLI)");

    await expect(syncOpenCode(
      bb,
      db as unknown as ReturnType<BbPluginApi["storage"]["database"]>,
      { id: "host-1", name: "Machine" },
      new AbortController().signal,
      async () => "__BB_USAGE_BEGIN__\n[{}]\n__BB_USAGE_END__:0\n__BB_HOST_COMMAND_DONE__:0\n",
    )).resolves.toBeUndefined();

    expect(db.prepare("SELECT COUNT(*) count FROM usage_events").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT status, record_count recordCount, error FROM usage_sync_state").get()).toEqual({
      status: "unavailable", recordCount: 1, error: "OpenCode returned an invalid aggregate row at index 0.",
    });
    db.close();
  });

  it("buckets OpenCode usage by the enrolled host's local day, not UTC", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, time_updated INTEGER NOT NULL);
      CREATE TABLE message (session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    `);
    const seed = (localHour: number, localMinute: number, id: string) => {
      const d = new Date();
      d.setHours(localHour, localMinute, 0, 0);
      const t = d.getTime();
      db.prepare("INSERT INTO session (id, time_updated) VALUES (?, ?)").run(id, t);
      db.prepare("INSERT INTO message (session_id, time_created, data) VALUES (?, ?, ?)").run(
        id,
        t,
        JSON.stringify({
          role: "assistant",
          providerID: "anthropic",
          modelID: "claude-sonnet-5",
          cost: 0.02,
          tokens: { input: 100, "cache.read": 60, "cache.write": 5, output: 15, reasoning: 5 },
        }),
      );
      return t;
    };
    // Local 00:30 exercises positive offsets (UTC day is the previous day);
    // local 17:30 exercises negative offsets (UTC day is the next day).
    const tA = seed(0, 30, "sA");
    const tB = seed(17, 30, "sB");
    const rows = db.prepare(openCodeSql()).all() as Array<{ day: string }>;
    const days = new Set(rows.map((r) => r.day));
    expect(days.has(localDay(tA))).toBe(true);
    expect(days.has(localDay(tB))).toBe(true);
    db.close();
  });

  it("cuts off at real local midnight, not a mis-converted epoch", () => {
    // 'localtime' shifts the value into local time but '%s' still formats it
    // as UTC, so the cutoff needs a trailing 'utc' to become a real epoch.
    // Without it the boundary drifts by the host's offset (7h in Los Angeles,
    // 12h in Auckland), dropping or admitting hours of the oldest day.
    const db = new Database(":memory:");
    const cutoff = db.prepare(
      "SELECT CAST(strftime('%s','now','localtime','start of day','-89 days','utc') AS INTEGER) c",
    ).get() as { c: number };
    const asLocal = new Date(cutoff.c * 1000);
    expect(asLocal.getHours()).toBe(0);
    expect(asLocal.getMinutes()).toBe(0);
    expect(openCodeSql()).not.toContain("'start of day', '-89 days')");
    db.close();
  });
});

describe("Devin collector sync", () => {
  function usageDb() {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE usage_events (
        event_key TEXT PRIMARY KEY, timestamp TEXT NOT NULL, day TEXT NOT NULL,
        provider_id TEXT NOT NULL, provider_name TEXT NOT NULL, model TEXT NOT NULL,
        cost_usd REAL NOT NULL, cache_savings_usd REAL NOT NULL, processed_tokens INTEGER NOT NULL,
        cached_input_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL,
        uncached_input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        model_provider_id TEXT NOT NULL DEFAULT 'unknown', model_provider_name TEXT NOT NULL DEFAULT 'Unknown',
        logged_cost_usd REAL, pricing_status TEXT NOT NULL DEFAULT 'unknown', project TEXT NOT NULL DEFAULT 'Unknown'
      );
      CREATE TABLE usage_sources (
        source_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, machine_name TEXT NOT NULL,
        provider_id TEXT NOT NULL, root_reference TEXT NOT NULL, content_sha TEXT NOT NULL,
        last_seen_generation TEXT NOT NULL, last_success_at TEXT NOT NULL, pricing_version TEXT
      );
      CREATE TABLE usage_event_sources (event_key TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY (event_key, source_id));
      CREATE TABLE usage_sync_state (
        machine_id TEXT NOT NULL, provider_id TEXT NOT NULL, status TEXT NOT NULL, last_attempt_at TEXT,
        last_success_at TEXT, record_count INTEGER NOT NULL DEFAULT 0, error TEXT, PRIMARY KEY (machine_id, provider_id)
      );
    `);
    return db;
  }

  function decodeCollectorInput(command: string) {
    const outer = command.match(/Buffer\.from\("([A-Za-z0-9+/=]+)"/);
    if (!outer) return null;
    const source = gunzipSync(Buffer.from(outer[1]!, "base64")).toString("utf8");
    const inner = source.match(/\}\)\("([A-Za-z0-9+/=]+)"/);
    if (!inner) return null;
    return JSON.parse(Buffer.from(inner[1]!, "base64").toString("utf8")) as { agentId?: string; dbPaths?: string[] };
  }

  it("targets the Devin CLI session database through a node collector", () => {
    const command = devinCommand("/home/user");
    expect(command).toContain("command -v node");
    expect(command).toContain("node -e");
    const input = decodeCollectorInput(command);
    expect(input).toMatchObject({
      agentId: "devin",
      dbPaths: [
        "/home/user/.local/share/devin/cli/sessions.db",
        "/home/user/Library/Application Support/devin/cli/sessions.db",
      ],
    });
  });

  it("stores scanned Devin aggregates and reports ready", async () => {
    const db = usageDb();
    const info = vi.fn();
    const bb = { log: { info, warn: vi.fn() } } as unknown as BbPluginApi;
    const output = fakeHostScanOutput("devin", [{
      day: new Date().toISOString().slice(0, 10),
      modelProviderId: "devin",
      model: "swe-2-max",
      project: "project-a",
      loggedCostUsd: null,
      uncachedInputTokens: 150,
      cachedInputTokens: 60,
      cacheWriteTokens: 5,
      outputTokens: 30,
    }]);

    await syncDevin(
      bb,
      db as unknown as ReturnType<BbPluginApi["storage"]["database"]>,
      { id: "host-1", name: "Machine" },
      "/home/user",
      new AbortController().signal,
      async () => output,
    );

    const event = db.prepare("SELECT provider_id, provider_name, model, project, processed_tokens, pricing_status FROM usage_events").get();
    expect(event).toEqual({
      provider_id: "devin", provider_name: "Devin", model: "swe-2-max",
      project: "project-a", processed_tokens: 245, pricing_status: "unknown",
    });
    expect(db.prepare("SELECT status, record_count recordCount FROM usage_sync_state").get())
      .toEqual({ status: "ready", recordCount: 1 });
    db.close();
  });

  it("reports no-data when the host scan finds no Devin session database", async () => {
    const db = usageDb();
    const bb = { log: { info: vi.fn(), warn: vi.fn() } } as unknown as BbPluginApi;

    await syncDevin(
      bb,
      db as unknown as ReturnType<BbPluginApi["storage"]["database"]>,
      { id: "host-1", name: "Machine" },
      "/home/user",
      new AbortController().signal,
      async () => fakeHostScanOutput("devin", []),
    );

    expect(db.prepare("SELECT status, record_count recordCount, error FROM usage_sync_state").get())
      .toEqual({ status: "no-data", recordCount: 0, error: null });
    db.close();
  });

  it("retains prior usage and isolates a failed Devin scan to its source state", async () => {
    const db = usageDb();
    db.prepare("INSERT INTO usage_events (event_key, timestamp, day, provider_id, provider_name, model, cost_usd, cache_savings_usd, processed_tokens, cached_input_tokens, cache_write_tokens, uncached_input_tokens, output_tokens) VALUES ('devin-event', '2026-08-09T00:00:00Z', '2026-08-09', 'devin', 'Devin', 'swe-2-max', 0, 0, 60, 0, 0, 40, 20)").run();
    db.prepare("INSERT INTO usage_sources (source_id, machine_id, machine_name, provider_id, root_reference, content_sha, last_seen_generation, last_success_at) VALUES ('devin-source', 'host-1', 'Machine', 'devin', 'ref', 'sha', 'gen', '2026-08-09T00:00:00Z')").run();
    db.prepare("INSERT INTO usage_event_sources (event_key, source_id) VALUES ('devin-event', 'devin-source')").run();
    const warn = vi.fn();
    const bb = { log: { info: vi.fn(), warn } } as unknown as BbPluginApi;

    await syncDevin(
      bb,
      db as unknown as ReturnType<BbPluginApi["storage"]["database"]>,
      { id: "host-1", name: "Machine" },
      "/home/user",
      new AbortController().signal,
      async () => { throw new Error("Node.js is required to scan Devin usage."); },
    );

    expect(db.prepare("SELECT COUNT(*) count FROM usage_events").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT status, record_count recordCount, error FROM usage_sync_state").get()).toEqual({
      status: "unavailable",
      recordCount: 1,
      error: "Usage scan failed: Node.js is required to scan Devin usage.",
    });
    expect(warn).toHaveBeenCalledWith("Machine/devin: Usage scan failed: Node.js is required to scan Devin usage.");
    db.close();
  });

  it("dispatches a Devin scan through syncAll like the JSON agents", async () => {
    const db = new Database(":memory:");
    let handlers: { sync: () => unknown } | undefined;
    const commandsByTerminalId = new Map<string, string>();
    const stagedFiles = new Map<string, string>();
    const bb = {
      settings: { define: vi.fn(() => ({ get: async () => ({ piSessionRoots: "", primeSessionRoots: "" }) })) },
      storage: {
        database: vi.fn(() => db),
        migrate: vi.fn((_db: unknown, statements: string[]) => { for (const statement of statements) db.exec(statement); }),
      },
      rpc: {
        register: vi.fn((_contract: unknown, registered: unknown) => {
          handlers = registered as { sync: () => unknown };
        }),
      },
      sdk: {
        hosts: {
          list: vi.fn(async () => [{ id: "host-1", name: "Machine", status: "connected" }]),
          directory: vi.fn(async () => ({ directory: "/home/user" })),
        },
        files: { write: hostFileWriteMock(stagedFiles) },
        terminals: {
          create: vi.fn(async (input: { start: { command: string } }) => {
            const id = `terminal-${commandsByTerminalId.size}`;
            commandsByTerminalId.set(id, input.start.command);
            return { id, status: "starting" };
          }),
          get: vi.fn(async (args: { terminalId: string }) => ({ id: args.terminalId, status: "running" })),
          output: vi.fn(async (args: { terminalId: string }) => {
            const agentId = decodeCollectorInput(commandTextFor(commandsByTerminalId.get(args.terminalId) ?? "", stagedFiles))?.agentId;
            const text = agentId === "devin"
              ? fakeHostScanOutput("devin", [{
                day: new Date().toISOString().slice(0, 10),
                modelProviderId: "devin",
                model: "swe-2-max",
                project: "project-a",
                loggedCostUsd: null,
                uncachedInputTokens: 150,
                cachedInputTokens: 60,
                cacheWriteTokens: 5,
                outputTokens: 30,
              }])
              : fakeHostScanOutput(agentId ?? "codex", []);
            return { chunks: [{ seq: 1, dataBase64: Buffer.from(text).toString("base64") }], truncated: false };
          }),
          close: vi.fn(async () => undefined),
        },
      },
      realtime: { publish: vi.fn() },
      background: { service: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as BbPluginApi;

    await plugin(bb);
    expect(handlers?.sync()).toEqual({ ok: true });

    await vi.waitFor(() => {
      const row = db.prepare("SELECT provider_id FROM usage_events WHERE provider_id = 'devin'").get();
      expect(row).toBeTruthy();
    }, { timeout: 2000 });

    expect(db.prepare(
      "SELECT status, record_count recordCount FROM usage_sync_state WHERE machine_id = 'host-1' AND provider_id = 'devin'",
    ).get()).toEqual({ status: "ready", recordCount: 1 });
    db.close();
  });
});

describe("dashboard query", () => {
  it("fetches one buffer day beyond the 90 the UI shows", () => {
    // The server timezone must not clip a host that is already on the next
    // local day; the dashboard applies the exact 90-day range itself.
    const sql = dashboardRecordsSql();
    expect(sql).toContain("day >= date('now', 'localtime', '-90 days')");
    expect(sql).not.toContain("-365 days");
  });
});

describe("OpenCode Go limits", () => {
  const markedOutput = [
    "__BB_USAGE_BEGIN__",
    JSON.stringify({ usage: { rolling: { status: "ok", percent: 4, resetsAt: "2026-08-21T22:54:37.384Z" } } }),
    "__BB_USAGE_END__:0",
    "",
  ].join("\n");

  function goLimitsDb() {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE opencode_go_limits (
      machine_id TEXT PRIMARY KEY, machine_name TEXT NOT NULL, plan_label TEXT NOT NULL DEFAULT 'Go',
      windows_json TEXT NOT NULL, fetched_at TEXT NOT NULL, account_fingerprint TEXT
    );
    CREATE TABLE opencode_go_limit_state (
      machine_id TEXT PRIMARY KEY, machine_name TEXT NOT NULL, status TEXT NOT NULL,
      error TEXT, last_attempt_at TEXT NOT NULL, last_success_at TEXT
    )`);
    return db;
  }

  it("persists a parsed snapshot from a successful host query", async () => {
    const db = goLimitsDb();
    const info = vi.fn();
    const bb = { log: { info, warn: vi.fn(), debug: vi.fn() } } as unknown as BbPluginApi;

    await syncOpenCodeGo(bb, db as unknown as ReturnType<BbPluginApi["storage"]["database"]>, { id: "host-1", name: "Machine" }, new AbortController().signal, async () => markedOutput);

    const row = db.prepare("SELECT machine_id, machine_name, plan_label, windows_json FROM opencode_go_limits").get() as {
      machine_id: string; machine_name: string; plan_label: string; windows_json: string;
    };
    expect(row).toEqual({
      machine_id: "host-1",
      machine_name: "Machine",
      plan_label: "Go",
      windows_json: JSON.stringify([{ label: "Rolling (5h)", usedPercent: 4, resetsAt: "2026-08-21T22:54:37.384Z" }]),
    });
    expect(info).toHaveBeenCalledWith(expect.stringContaining("1 limit windows"));
    expect(db.prepare("SELECT status, error, last_success_at IS NOT NULL hasSuccess FROM opencode_go_limit_state").get())
      .toEqual({ status: "ok", error: null, hasSuccess: 1 });
  });

  it("persists the credential fingerprint as the grouping identity", async () => {
    const db = goLimitsDb();
    const bb = { log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } } as unknown as BbPluginApi;
    const output = [
      `__BB_GO_FINGERPRINT__:${"a".repeat(64)}`,
      "__BB_USAGE_BEGIN__",
      JSON.stringify({ usage: { rolling: { status: "ok", percent: 4, resetsAt: "2026-08-21T22:54:37.384Z" } } }),
      "__BB_USAGE_END__:0",
      "",
    ].join("\n");

    await syncOpenCodeGo(bb, db as unknown as ReturnType<BbPluginApi["storage"]["database"]>, { id: "host-1", name: "Machine" }, new AbortController().signal, async () => output);

    expect(loadStoredOpenCodeGoLimits(db as unknown as ReturnType<BbPluginApi["storage"]["database"]>, new Set(["host-1"])))
      .toEqual([expect.objectContaining({ accountIdentity: "a".repeat(64) })]);
  });

  it("retains the previous snapshot when a later fetch fails generically", async () => {
    const db = goLimitsDb();
    const warn = vi.fn();
    const bb = { log: { info: vi.fn(), warn, debug: vi.fn() } } as unknown as BbPluginApi;
    await syncOpenCodeGo(bb, db as unknown as ReturnType<BbPluginApi["storage"]["database"]>, { id: "host-1", name: "Machine" }, new AbortController().signal, async () => markedOutput);

    await syncOpenCodeGo(bb, db as unknown as ReturnType<BbPluginApi["storage"]["database"]>, { id: "host-1", name: "Machine" }, new AbortController().signal, async () => {
      throw new Error("Usage: OpenCode Go limits timed out after 60 seconds.");
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("retaining previous snapshot"));
    expect((db.prepare("SELECT COUNT(*) count FROM opencode_go_limits").get() as { count: number }).count).toBe(1);
    expect(db.prepare("SELECT status, error FROM opencode_go_limit_state").get()).toEqual({
      status: "error",
      error: "Usage: OpenCode Go limits timed out after 60 seconds.",
    });
    expect(loadStoredOpenCodeGoLimits(db as unknown as ReturnType<BbPluginApi["storage"]["database"]>, new Set(["host-1"])))
      .toEqual([expect.objectContaining({ status: "error", windows: [expect.objectContaining({ label: "Rolling (5h)" })] })]);
  });

  it("retains the previous snapshot for diagnostics that only contain a sentinel", async () => {
    const db = goLimitsDb();
    const warn = vi.fn();
    const bb = { log: { info: vi.fn(), warn, debug: vi.fn() } } as unknown as BbPluginApi;
    await syncOpenCodeGo(bb, db as unknown as ReturnType<BbPluginApi["storage"]["database"]>, { id: "host-1", name: "Machine" }, new AbortController().signal, async () => markedOutput);

    for (const diagnostic of [
      "collector failed near no-opencode-go-credential handling",
      "no-opencode-go-plan response was malformed",
    ]) {
      await syncOpenCodeGo(bb, db as unknown as ReturnType<BbPluginApi["storage"]["database"]>, { id: "host-1", name: "Machine" }, new AbortController().signal, async () => {
        throw new Error(diagnostic);
      });
    }

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("retaining previous snapshot"));
    expect((db.prepare("SELECT COUNT(*) count FROM opencode_go_limits").get() as { count: number }).count).toBe(1);
    expect((db.prepare("SELECT COUNT(*) count FROM opencode_go_limit_state").get() as { count: number }).count).toBe(1);
  });

  it("drops the stored snapshot when the machine has no Go credential or plan", async () => {
    const db = goLimitsDb();
    const debug = vi.fn();
    const bb = { log: { info: vi.fn(), warn: vi.fn(), debug } } as unknown as BbPluginApi;
    await syncOpenCodeGo(bb, db as unknown as ReturnType<BbPluginApi["storage"]["database"]>, { id: "host-1", name: "Machine" }, new AbortController().signal, async () => markedOutput);

    for (const diagnostic of ["no-opencode-go-credential", "no-opencode-go-plan"]) {
      await syncOpenCodeGo(bb, db as unknown as ReturnType<BbPluginApi["storage"]["database"]>, { id: "host-1", name: "Machine" }, new AbortController().signal, async () => {
        throw new Error(diagnostic);
      });
    }

    expect(debug).toHaveBeenCalledWith(expect.stringContaining("not configured"));
    expect((db.prepare("SELECT COUNT(*) count FROM opencode_go_limits").get() as { count: number }).count).toBe(0);
    expect((db.prepare("SELECT COUNT(*) count FROM opencode_go_limit_state").get() as { count: number }).count).toBe(0);
  });

  it("serves connected snapshots and surfaces malformed cached data as an error", () => {
    const db = goLimitsDb();
    db.prepare("INSERT INTO opencode_go_limits (machine_id, machine_name, plan_label, windows_json, fetched_at) VALUES (?, ?, 'Go', ?, ?)")
      .run("host-1", "Machine", JSON.stringify([{ label: "Weekly", usedPercent: 25, resetsAt: null }]), new Date().toISOString());
    db.prepare("INSERT INTO opencode_go_limit_state (machine_id, machine_name, status, error, last_attempt_at, last_success_at) VALUES (?, ?, 'ok', NULL, ?, ?)")
      .run("host-1", "Machine", new Date().toISOString(), new Date().toISOString());

    db.prepare("INSERT INTO opencode_go_limits (machine_id, machine_name, plan_label, windows_json, fetched_at) VALUES (?, ?, 'Go', ?, ?)")
      .run("host-2", "Broken", "{invalid", new Date().toISOString());
    db.prepare("INSERT INTO opencode_go_limit_state (machine_id, machine_name, status, error, last_attempt_at, last_success_at) VALUES (?, ?, 'ok', NULL, ?, ?)")
      .run("host-2", "Broken", new Date().toISOString(), new Date().toISOString());

    const limits = loadStoredOpenCodeGoLimits(db as unknown as ReturnType<BbPluginApi["storage"]["database"]>, new Set(["host-1", "host-2"]));
    expect(limits.find((limit) => limit.machineId === "host-1")).toEqual(expect.objectContaining({
      machineId: "host-1",
      providerId: "opencode-go",
      providerName: "OpenCode Go",
      planLabel: "Go",
      status: "ok",
      lastUpdatedAt: expect.any(String),
    }));
    expect(limits.find((limit) => limit.machineId === "host-2")).toEqual(expect.objectContaining({
      machineId: "host-2", status: "error", error: "Stored OpenCode Go limits could not be read.",
    }));
  });
});


it("prices OpenCode mixed recorded and unpriced requests independently", async () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE session (id TEXT, time_updated INTEGER); CREATE TABLE message (session_id TEXT, time_created INTEGER, data TEXT);");
    const now = Date.now();
    db.prepare("INSERT INTO session VALUES (?, ?)").run("test", now);
    for (const cost of [7, 0]) db.prepare("INSERT INTO message VALUES (?, ?, ?)").run("test", now, JSON.stringify({
      role: "assistant", providerID: "openai", modelID: "gpt-5.6-sol", cost, tokens: { input: 1000000, output: 0 },
    }));
    const { parseOpenCode } = await import("./collectors");
    const rows = parseOpenCode(JSON.stringify(db.prepare(openCodeSql()).all()), { machineId: "test", machineName: "test" });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(r => r.eventKey)).size).toBe(2);
    expect(rows.reduce((sum, r) => sum + r.costUsd, 0)).toBe(12);
  } finally { db.close(); }
});


describe("Grok limit snapshots", () => {
  it("hides first-time errors while retaining diagnostics, then shows valid zero usage", async () => {
    const db = new Database(":memory:");
    try {
      db.exec(grokLimitsMigration);
      const warn = vi.fn();
      const bb = { log: { warn } } as unknown as BbPluginApi;
      const machine = { id: "host-grok", name: "Grok machine" };
      const connected = new Set([machine.id]);
      await syncGrokLimits(bb, db, machine, AbortSignal.timeout(1000), async () => { throw new Error("Node.js is required"); });
      expect(loadStoredGrokLimits(db, connected)).toEqual([]);
      expect(db.prepare("SELECT error FROM grok_limits").get()).toEqual({ error: "Node.js is required" });
      expect(warn).toHaveBeenCalled();
      const snapshot = { accountIdentity: "a".repeat(64), windows: [{ label: "Weekly credits", usedPercent: 0, resetsAt: null }] };
      await syncGrokLimits(bb, db, machine, AbortSignal.timeout(1000), async () => `__BB_USAGE_BEGIN__\n${JSON.stringify(snapshot)}\n__BB_USAGE_END__:0`);
      expect(loadStoredGrokLimits(db, connected)).toEqual([expect.objectContaining({ status: "ok", error: null, windows: snapshot.windows })]);
    } finally { db.close(); }
  });

  it("retains a successful snapshot on errors, hides offline machines, and clears on logout", async () => {
    const db = new Database(":memory:");
    db.exec(grokLimitsMigration);
    const bb = { log: { warn: vi.fn() } } as unknown as BbPluginApi;
    const machine = { id: "host-grok", name: "Grok machine" };
    const snapshot = { accountIdentity: "a".repeat(64), windows: [{ label: "Weekly credits", usedPercent: 40, resetsAt: null }] };
    await syncGrokLimits(bb, db, machine, AbortSignal.timeout(1000), async () => `__BB_USAGE_BEGIN__\n${JSON.stringify(snapshot)}\n__BB_USAGE_END__:0`);
    expect(loadStoredGrokLimits(db, new Set([machine.id]))).toEqual([expect.objectContaining({ status: "ok", windows: snapshot.windows, accountIdentity: snapshot.accountIdentity })]);
    await syncGrokLimits(bb, db, machine, AbortSignal.timeout(1000), async () => { throw new Error("Request failed"); });
    expect(loadStoredGrokLimits(db, new Set([machine.id]))).toEqual([expect.objectContaining({ status: "error", windows: snapshot.windows, error: "Request failed" })]);
    expect(loadStoredGrokLimits(db, new Set())).toEqual([]);
    await syncGrokLimits(bb, db, machine, AbortSignal.timeout(1000), async () => "__BB_USAGE_ERROR__:no-grok-credential");
    expect(loadStoredGrokLimits(db, new Set([machine.id]))).toEqual([]);
    db.close();
  });
});
