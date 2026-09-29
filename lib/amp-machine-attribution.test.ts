import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@bb/plugin-sdk";
import type { AmpUsageScanResult } from "./amp-usage-collector";
import { getSourceIssueMessage } from "./usage-view-state";

vi.mock("@bb/plugin-sdk", () => ({ defineRpcContract: <T>(contract: T) => contract }));
import plugin, { rpcContract, syncAmp } from "../server";
import type { z } from "zod";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

async function setup() {
  const db = new Database(":memory:");
  databases.push(db);
  const machines = [
    { id: "a-collector", name: "Collecting machine", status: "connected" },
    { id: "z-origin", name: "Initial machine", status: "offline" },
  ];
  let dashboard!: () => Promise<z.infer<typeof rpcContract.dashboard.output>>;
  const bb = {
    settings: { define: vi.fn() },
    storage: {
      database: () => db,
      migrate: (_db: unknown, statements: string[]) => { for (const sql of statements) db.exec(sql); },
    },
    sdk: { hosts: { list: async () => machines } },
    rpc: { register: (_contract: unknown, handlers: { dashboard: typeof dashboard }) => { dashboard = handlers.dashboard; } },
    background: { service: vi.fn() },
    log: { info: vi.fn(), warn: vi.fn() },
  } as unknown as BbPluginApi;
  await plugin(bb);
  async function scan(machineIndex: number, localInstallationId: string | null, origins: Array<string | null>, failureCount = 0) {
    const result: AmpUsageScanResult = {
      agentId: "amp", localInstallationId, threadCount: origins.length, changedThreadCount: origins.length,
      reusedThreadCount: 0, failureCount, error: failureCount ? "Export failed" : null,
      threads: origins.map((initialInstallationId, i) => ({
        threadId: `T-origin-${i}`, updated: new Date().toISOString(), initialInstallationId,
        rows: [{
          threadId: `T-origin-${i}`, day: new Date().toISOString().slice(0, 10),
          modelProviderId: "amp", model: "gpt-6-astra", project: "project", loggedCostUsd: null,
          uncachedInputTokens: 13 + i, cachedInputTokens: 7, cacheWriteTokens: 3, outputTokens: 2,
        }],
      })),
    };
    await syncAmp(bb, db as unknown as ReturnType<BbPluginApi["storage"]["database"]>, machines[machineIndex]!,
      "/home/test", new AbortController().signal, async () =>
        `__BB_AMP_USAGE_SCAN_BEGIN__\n${gzipSync(JSON.stringify(result)).toString("base64")}\n__BB_AMP_USAGE_SCAN_END__\n`);
    expect(bb.log.warn).not.toHaveBeenCalled();
  }
  return { db, dashboard, scan };
}

describe("Amp initial-machine attribution", () => {
  it.each(["fresh", "amp", "codex", "codex-with-amp-tables"])("preserves %s migration history through upgrade and restart", async (lineage) => {
    const db = new Database(":memory:");
    databases.push(db);
    let statements: string[] = [];
    const capture = new Error("capture migration statements");
    const migrate = vi.fn((_db: unknown, sql: string[]): void => { statements = sql; throw capture; });
    const bb = {
      settings: { define: vi.fn() },
      storage: { database: () => db, migrate },
      rpc: { register: vi.fn() },
      background: { service: vi.fn() },
      log: { info: vi.fn() },
    } as unknown as BbPluginApi;
    await expect(plugin(bb)).rejects.toBe(capture);
    const hash = (sql: string) => createHash("sha256").update(sql).digest("hex");
    // Pin the already-shipped Amp statement, not just the current implementation.
    const oldAmp = statements[10]!.replaceAll("CREATE TABLE IF NOT EXISTS ", "CREATE TABLE ");
    expect(hash(oldAmp)).toBe("613d0227ce7cf7eeb4deadf4560dadab9f0ac903e063258e12a791eae8d1365d");
    expect(hash(statements[9]!)).toBe("db06d4e6c53132f704d8cc0cb65c38a29564324d52942f15bb464977c617176d");
    const applied = new Map<number, string>();
    if (lineage !== "fresh") {
      const previous = [...statements.slice(0, 9), lineage === "amp" ? oldAmp : statements[9]!];
      previous.forEach((sql, index) => { db.exec(sql); applied.set(index, hash(sql)); });
      db.prepare("INSERT INTO usage_metadata VALUES ('last_completed_sync_at', '2026-09-28T12:34:56Z')").run();
      if (lineage === "codex-with-amp-tables") db.exec(oldAmp);
      if (lineage.includes("amp")) db.exec("INSERT INTO amp_installations VALUES ('known-installation', 'original-host')");
    }
    const before = new Map(applied);
    migrate.mockImplementation((_db, sql) => {
      // BB validates exact SQL hashes at each positional index before applying.
      sql.forEach((statement, index) => {
        if (applied.has(index)) expect(hash(statement)).toBe(applied.get(index));
      });
      db.transaction(() => {
        sql.forEach((statement, index) => {
          if (!applied.has(index)) { db.exec(statement); applied.set(index, hash(statement)); }
        });
      })();
    });
    await plugin(bb);
    await plugin(bb);
    expect(applied.size).toBe(11);
    for (const [index, digest] of before) expect(applied.get(index)).toBe(digest);
    expect(db.prepare("SELECT name FROM pragma_table_info('usage_sources') WHERE name='attribution'").get()).toBeTruthy();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='amp_thread_origins'").get()).toBeTruthy();
    if (lineage !== "fresh") expect(db.prepare("SELECT value FROM usage_metadata WHERE key='last_completed_sync_at'").get())
      .toEqual({ value: "2026-09-28T12:34:56Z" });
    if (lineage.includes("amp")) expect(db.prepare("SELECT * FROM amp_installations").all())
      .toEqual([{ installation_id: "known-installation", machine_id: "original-host" }]);
  });

  it("resolves another machine independently of collection order and deduplicates account usage", async () => {
    const { db, dashboard, scan } = await setup();
    await scan(0, "collector-install", ["origin-install", "collector-install", null]);
    let data = await dashboard();
    expect(data.records.map(r => [r.machineId, r.processedTokens])).toEqual(expect.arrayContaining([
      ["a-collector", 26], ["amp-other", 52],
    ]));
    expect(data.machines).toContainEqual(expect.objectContaining({ id: "amp-other", name: "Amp: Other / unknown environment" }));
    expect(getSourceIssueMessage(data.machines.filter(m => m.id !== "z-origin"), data.sources)).toBeNull();
    expect(data.notice).toContain("initial machine");

    // Register the origin after the remote thread has already been collected.
    await scan(1, "origin-install", ["origin-install", "collector-install", null]);
    data = await dashboard();
    expect(data.records.map(r => [r.machineId, r.processedTokens])).toEqual(expect.arrayContaining([
      ["z-origin", 25], ["a-collector", 26], ["amp-other", 27],
    ]));
    expect(data.records).toHaveLength(3);
    expect(data.records.find(r => r.machineId === "z-origin")?.machineName).toBe("Initial machine");
    expect(db.prepare("SELECT COUNT(*) n FROM usage_event_sources").get()).toEqual({ n: 6 });

    // Source cleanup remains scoped to the collecting machine, not attribution.
    await scan(0, "collector-install", []);
    expect((await dashboard()).records).toEqual(data.records);
    expect(db.prepare("SELECT COUNT(*) n FROM usage_event_sources").get()).toEqual({ n: 3 });
  });

  it("keeps legacy and missing identities out of the collecting machine even during partial refresh", async () => {
    const { db, dashboard, scan } = await setup();
    await scan(0, "collector-install", ["collector-install"]);
    // An upgraded database has usage sources but no initial-environment metadata.
    db.exec("DELETE FROM amp_thread_origins");
    expect((await dashboard()).records[0]).toMatchObject({ machineId: "amp-other", processedTokens: 25 });
    await scan(0, null, [], 1);
    expect((await dashboard()).records[0]).toMatchObject({ machineId: "amp-other", processedTokens: 25 });
    await scan(0, "collector-install", ["collector-install"]);
    expect((await dashboard()).records[0]).toMatchObject({ machineId: "a-collector", processedTokens: 25 });
    expect((await dashboard()).machines.some(m => m.id === "amp-other")).toBe(false);
  });

  it("retains historical installation matches after reinstall and rejects ambiguous cloned identities", async () => {
    const { dashboard, scan } = await setup();
    await scan(0, "old-install", ["old-install"]);
    await scan(0, "new-install", ["old-install"]);
    expect((await dashboard()).records[0]).toMatchObject({ machineId: "a-collector", processedTokens: 25 });
    await scan(1, "old-install", ["old-install"]);
    expect((await dashboard()).records).toEqual([
      expect.objectContaining({ machineId: "amp-other", processedTokens: 25 }),
    ]);
  });

  it("does not let a duplicate source erase or override another source's initial identity", async () => {
    const { dashboard, scan } = await setup();
    await scan(0, "collector-install", ["collector-install"]);
    await scan(1, "origin-install", [null]);
    expect((await dashboard()).records[0]).toMatchObject({ machineId: "a-collector", processedTokens: 25 });
    await scan(1, "origin-install", ["origin-install"]);
    expect((await dashboard()).records[0]).toMatchObject({ machineId: "amp-other", processedTokens: 25 });
    await scan(0, "collector-install", ["collector-install"]);
    expect((await dashboard()).records[0]).toMatchObject({ machineId: "amp-other", processedTokens: 25 });
    await scan(1, "origin-install", []);
    expect((await dashboard()).records[0]).toMatchObject({ machineId: "a-collector", processedTokens: 25 });
  });
});
