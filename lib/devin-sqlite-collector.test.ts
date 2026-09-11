import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { compressedDevinCollectorScript } from "./devin-sqlite-collector";
import { extractHostJsonScan } from "./host-json-collector";

function localDay(timestamp: string): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "bb-usage-devin-scan-"));
  temporaryDirectories.push(directory);
  return directory;
}

function seedSessionsDb(dbPath: string) {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, working_directory TEXT, model TEXT, metadata TEXT
  );
  CREATE TABLE message_nodes (
    row_id INTEGER PRIMARY KEY, session_id TEXT, node_id INTEGER,
    chat_message TEXT, created_at INTEGER, metadata TEXT
  );`);
  const insertSession = db.prepare("INSERT INTO sessions (id, working_directory, model, metadata) VALUES (?, ?, ?, ?)");
  const insertNode = db.prepare("INSERT INTO message_nodes (session_id, node_id, chat_message, created_at) VALUES (?, ?, ?, ?)");
  return {
    session: (id: string, workingDirectory: string | null, model: string | null, metadata: string | null = null) =>
      insertSession.run(id, workingDirectory, model, metadata),
    node: (sessionId: string, nodeId: number, message: unknown, createdAtSeconds: number) =>
      insertNode.run(sessionId, nodeId, typeof message === "string" ? message : JSON.stringify(message), createdAtSeconds),
    close: () => db.close(),
  };
}

function assistantMessage(requestId: string | null, metrics: Record<string, number | null> | null, createdAt: string) {
  return {
    message_id: `msg-${Math.random().toString(36).slice(2)}`,
    role: "assistant",
    content: "private devin content",
    metadata: { request_id: requestId, metrics, created_at: createdAt },
  };
}

async function scan(dbPath: string, sinceDay = "2026-08-01", env?: NodeJS.ProcessEnv) {
  const script = compressedDevinCollectorScript({ agentId: "devin", dbPaths: [dbPath], sinceDay });
  expect(script.length).toBeLessThan(9_000);
  const { stdout } = await execFileAsync(process.execPath, ["-e", script], { maxBuffer: 2 * 1024 * 1024, env: env ?? process.env });
  return extractHostJsonScan(stdout.replace(/\n/g, "\r\n"));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("devin SQLite collector", () => {
  it("aggregates per-request usage by local day, model, and project", async () => {
    const directory = await temporaryDirectory();
    const dbPath = join(directory, "sessions.db");
    const db = seedSessionsDb(dbPath);
    db.session("session-a", "/home/user/code/project-a", "swe-2-max");
    // The CLI records the same request metrics on several message nodes; each
    // API response must be counted once.
    db.node("session-a", 1, assistantMessage("request-1", { input_tokens: 100, output_tokens: 20, cache_read_tokens: 60, cache_creation_tokens: 5 }, "2026-08-09T00:00:01Z"), 1786000000);
    db.node("session-a", 2, assistantMessage("request-1", { input_tokens: 100, output_tokens: 20, cache_read_tokens: 60, cache_creation_tokens: 5 }, "2026-08-09T00:00:01Z"), 1786000000);
    db.node("session-a", 3, assistantMessage("request-2", { input_tokens: 50, output_tokens: 10, cache_read_tokens: null, cache_creation_tokens: null }, "2026-08-09T01:00:00Z"), 1786000001);
    db.close();

    const result = await scan(dbPath);
    expect(result).toMatchObject({ agentId: "devin", fileCount: 1, failureCount: 0 });
    expect(result.rows).toEqual([expect.objectContaining({
      day: localDay("2026-08-09T00:00:01Z"),
      modelProviderId: "devin",
      model: "swe-2-max",
      project: "project-a",
      loggedCostUsd: null,
      uncachedInputTokens: 150,
      cachedInputTokens: 60,
      cacheWriteTokens: 5,
      outputTokens: 30,
    })]);
    expect(JSON.stringify(result)).not.toContain("private devin content");
  });

  it("reports an empty scan when sessions.db does not exist", async () => {
    const directory = await temporaryDirectory();
    const result = await scan(join(directory, "sessions.db"));
    expect(result).toMatchObject({ agentId: "devin", fileCount: 0, failureCount: 0, rows: [] });
  });

  it("skips messages without metrics, zero-token events, and malformed rows", async () => {
    const directory = await temporaryDirectory();
    const dbPath = join(directory, "sessions.db");
    const db = seedSessionsDb(dbPath);
    db.session("session-a", "/home/user/code/project-a", "swe-2-max");
    db.node("session-a", 1, { role: "user", content: "assistant input_tokens", metadata: { created_at: "2026-08-09T00:00:00Z" } }, 1786000000);
    db.node("session-a", 2, assistantMessage(null, null, "2026-08-09T00:00:01Z"), 1786000000);
    db.node("session-a", 3, assistantMessage("request-zero", { input_tokens: 0, output_tokens: 0, cache_read_tokens: null, cache_creation_tokens: null }, "2026-08-09T00:00:02Z"), 1786000000);
    db.node("session-a", 4, `{"role":"assistant","content":"input_tokens",bad json`, 1786000000);
    db.node("session-a", 5, assistantMessage("request-ok", { input_tokens: 40, output_tokens: 10, cache_read_tokens: null, cache_creation_tokens: null }, "2026-08-09T00:00:03Z"), 1786000000);
    db.close();

    const result = await scan(dbPath);
    expect(result.failureCount).toBe(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ uncachedInputTokens: 40, outputTokens: 10 });
  });

  it("buckets by the message timestamp and drops usage older than the boundary", async () => {
    const directory = await temporaryDirectory();
    const dbPath = join(directory, "sessions.db");
    const db = seedSessionsDb(dbPath);
    db.session("session-a", "/home/user/code/project-a", "swe-2-max");
    db.node("session-a", 1, assistantMessage("request-old", { input_tokens: 10, output_tokens: 5, cache_read_tokens: null, cache_creation_tokens: null }, "2025-01-01T00:00:00Z"), 1735700000);
    db.node("session-a", 2, assistantMessage("request-new", { input_tokens: 10, output_tokens: 5, cache_read_tokens: null, cache_creation_tokens: null }, "2026-08-09T00:00:00Z"), 1786000000);
    db.close();

    const result = await scan(dbPath);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.day).toBe(localDay("2026-08-09T00:00:00Z"));
  });

  it("discovers the database under platform data directories like APPDATA", async () => {
    const directory = await temporaryDirectory();
    const appData = join(directory, "AppData", "Roaming");
    const dbPath = join(appData, "devin", "cli", "sessions.db");
    await mkdir(join(appData, "devin", "cli"), { recursive: true });
    const db = seedSessionsDb(dbPath);
    db.session("session-a", "/work/project-a", "swe-2-max");
    db.node("session-a", 1, assistantMessage("request-1", { input_tokens: 10, output_tokens: 5, cache_read_tokens: null, cache_creation_tokens: null }, "2026-08-09T00:00:00Z"), 1786000000);
    db.close();

    const result = await scan(join(directory, "absent", "sessions.db"), "2026-08-01", { ...process.env, APPDATA: appData });
    expect(result.rows).toEqual([expect.objectContaining({ uncachedInputTokens: 10, outputTokens: 5 })]);
  });

  it("labels sessions missing model or working directory as unknown", async () => {
    const directory = await temporaryDirectory();
    const dbPath = join(directory, "sessions.db");
    const db = seedSessionsDb(dbPath);
    db.session("session-empty", null, "");
    db.node("session-empty", 1, assistantMessage("request-1", { input_tokens: 10, output_tokens: 5, cache_read_tokens: null, cache_creation_tokens: null }, "2026-08-09T00:00:00Z"), 1786000000);
    db.node("session-orphan", 1, assistantMessage("request-2", { input_tokens: 10, output_tokens: 5, cache_read_tokens: null, cache_creation_tokens: null }, "2026-08-09T00:00:00Z"), 1786000000);
    db.close();

    const result = await scan(dbPath);
    expect(result.rows).toEqual([expect.objectContaining({
      model: "devin-unknown",
      project: "Unknown",
      uncachedInputTokens: 20,
      outputTokens: 10,
    })]);
  });
});
