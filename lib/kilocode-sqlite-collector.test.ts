import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { compressedKilocodeCollectorScript } from "./kilocode-sqlite-collector";
import { extractHostJsonScan } from "./host-json-collector";

function localDay(timestamp: string): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "bb-usage-kilocode-scan-"));
  temporaryDirectories.push(directory);
  return directory;
}

function seedKilocodeDb(dbPath: string) {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    workspace_id TEXT,
    parent_id TEXT,
    slug TEXT NOT NULL,
    directory TEXT NOT NULL,
    path TEXT,
    title TEXT NOT NULL,
    version TEXT,
    share_url TEXT,
    summary_additions INTEGER,
    summary_deletions INTEGER,
    summary_files INTEGER,
    summary_diffs TEXT,
    metadata TEXT,
    cost REAL DEFAULT 0,
    tokens_input INTEGER DEFAULT 0,
    tokens_output INTEGER DEFAULT 0,
    tokens_reasoning INTEGER DEFAULT 0,
    tokens_cache_read INTEGER DEFAULT 0,
    tokens_cache_write INTEGER DEFAULT 0,
    revert TEXT,
    permission TEXT,
    agent TEXT,
    model TEXT,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    time_compacting INTEGER,
    time_archived INTEGER
  );`);
  const insertSession = db.prepare("INSERT INTO session (id, project_id, slug, directory, model, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, time_created, time_updated, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  return {
    session: (id: string, projectId: string, slug: string, directory: string | null, model: string | null, cost: number | null, tokensInput: number, tokensOutput: number, tokensReasoning: number, tokensCacheRead: number, tokensCacheWrite: number, timeCreated: number, timeUpdated: number, title: string) =>
      insertSession.run(id, projectId, slug, directory, model, cost, tokensInput, tokensOutput, tokensReasoning, tokensCacheRead, tokensCacheWrite, timeCreated, timeUpdated, title),
    close: () => db.close(),
  };
}

async function scan(dbPath: string, sinceDay = "2026-08-01", env?: NodeJS.ProcessEnv) {
  const script = compressedKilocodeCollectorScript({ agentId: "kilocode", dbPaths: [dbPath], sinceDay });
  expect(script.length).toBeLessThan(9_000);
  const { stdout } = await execFileAsync(process.execPath, ["-e", script], { maxBuffer: 2 * 1024 * 1024, env: { ...process.env, XDG_DATA_HOME: "", APPDATA: "", HOME: join(tmpdir(), "nonexistent-kilo-test-" + Math.random().toString(36).slice(2)), ...env } });
  return extractHostJsonScan(stdout.replace(/\n/g, "\r\n"));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("kilocode SQLite collector", () => {
  it("aggregates per-session usage by local day, model, and project", async () => {
    const directory = await temporaryDirectory();
    const dbPath = join(directory, "kilo.db");
    const db = seedKilocodeDb(dbPath);
    db.session("ses-1", "proj-a", "ses-1", "/home/user/code/project-a", JSON.stringify({ id: "kilo-auto/free", providerID: "kilo" }), 0, 1000, 50, 100, 500, 0, 1791247014334, 1791247245255, "Test session");
    db.close();

    const result = await scan(dbPath);
    expect(result).toMatchObject({ agentId: "kilocode", fileCount: 1, failureCount: 0 });
    const expectedDay = localDay(new Date(1791247014334).toISOString());
    expect(result.rows).toEqual([expect.objectContaining({
      day: expectedDay,
      modelProviderId: "kilo",
      model: "kilo-auto/free",
      project: "project-a",
      loggedCostUsd: null,
      uncachedInputTokens: 500,
      cachedInputTokens: 500,
      cacheWriteTokens: 0,
      outputTokens: 150,
    })]);
  });

  it("reports an empty scan when kilo.db does not exist", async () => {
    const directory = await temporaryDirectory();
    const result = await scan(join(directory, "kilo.db"), "2026-08-01", { HOME: join(directory, "nonexistent") });
    expect(result).toMatchObject({ agentId: "kilocode", fileCount: 0, failureCount: 0, rows: [] });
  });

  it("skips sessions outside the sinceDay boundary", async () => {
    const directory = await temporaryDirectory();
    const dbPath = join(directory, "kilo.db");
    const db = seedKilocodeDb(dbPath);
    db.session("ses-old", "proj-old", "ses-old", "/home/user/code/old", JSON.stringify({ id: "kilo-auto/free", providerID: "kilo" }), 0, 100, 10, 10, 50, 0, 1700000000000, 1700000005000, "Old session");
    db.session("ses-new", "proj-new", "ses-new", "/home/user/code/new", JSON.stringify({ id: "kilo-auto/free", providerID: "kilo" }), 0, 100, 10, 10, 50, 0, 1791247014334, 1791247245255, "New session");
    db.close();

    const result = await scan(dbPath, "2026-08-01");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.project).toBe("new");
  });

  it("labels sessions missing model or working directory as unknown", async () => {
    const directory = await temporaryDirectory();
    const dbPath = join(directory, "kilo.db");
    const db = seedKilocodeDb(dbPath);
    db.session("ses-empty", "proj-empty", "ses-empty", "", null, 0, 10, 5, 5, 5, 0, 1791247014334, 1791247245255, "Empty session");
    db.session("ses-orphan", "proj-orphan", "ses-orphan", "/home/user/code/orphan", null, 0, 10, 5, 5, 5, 0, 1791247014334, 1791247245255, "Orphan session");
    db.close();

    const result = await scan(dbPath);
    expect(result.rows).toEqual([expect.objectContaining({
      model: "kilocode-unknown",
      project: "orphan",
      uncachedInputTokens: 5,
      outputTokens: 10,
    }), expect.objectContaining({
      model: "kilocode-unknown",
      project: "Unknown",
      uncachedInputTokens: 5,
      outputTokens: 10,
    })]);
  });

  it("discovers the database under XDG_DATA_HOME and APPDATA", async () => {
    const directory = await temporaryDirectory();
    const xdgData = join(directory, "xdg", "kilo");
    const dbPath = join(xdgData, "kilo.db");
    await mkdir(xdgData, { recursive: true });
    const db = seedKilocodeDb(dbPath);
    db.session("ses-1", "proj-a", "ses-1", "/work/project-a", JSON.stringify({ id: "kilo-auto/free", providerID: "kilo" }), 0, 100, 10, 10, 50, 0, 1791247014334, 1791247245255, "Test session");
    db.close();

    const result = await scan(join(directory, "absent", "kilo.db"), "2026-08-01", { XDG_DATA_HOME: join(directory, "xdg") });
    expect(result.rows).toEqual([expect.objectContaining({ uncachedInputTokens: 50, outputTokens: 20 })]);
  });

  it("preserves logged costs when present", async () => {
    const directory = await temporaryDirectory();
    const dbPath = join(directory, "kilo.db");
    const db = seedKilocodeDb(dbPath);
    db.session("ses-1", "proj-a", "ses-1", "/home/user/code/project-a", JSON.stringify({ id: "kilo-auto/free", providerID: "kilo" }), 0.05, 100, 10, 10, 50, 0, 1791247014334, 1791247245255, "Test session");
    db.close();

    const result = await scan(dbPath);
    expect(result.rows[0]!.loggedCostUsd).toBe(0.05);
  });
});
