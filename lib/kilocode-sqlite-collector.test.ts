import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { parseHostUsageAggregates } from "../collectors";
import { compressedKilocodeCollectorScript } from "./kilocode-sqlite-collector";
import { extractHostJsonScan } from "./host-json-collector";
import { resetPricingCatalog, setPricingCatalog } from "./pricing";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "bb-usage-kilocode-scan-"));
  temporaryDirectories.push(directory);
  return directory;
}

type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
const noTokens: Tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

// Mirrors the persisted tables of Kilo v7.8.3 (packages/core/src/session/sql.ts):
// v1 steps are `part` step-finish rows and v2 steps are `session_message`
// assistant rows; the session counters and message totals are derived copies.
function seedKilocodeDb(dbPath: string) {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT, slug TEXT NOT NULL,
    directory TEXT NOT NULL, path TEXT, title TEXT NOT NULL, version TEXT NOT NULL, share_url TEXT,
    summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT, metadata TEXT,
    cost REAL NOT NULL DEFAULT 0, tokens_input INTEGER NOT NULL DEFAULT 0, tokens_output INTEGER NOT NULL DEFAULT 0,
    tokens_reasoning INTEGER NOT NULL DEFAULT 0, tokens_cache_read INTEGER NOT NULL DEFAULT 0,
    tokens_cache_write INTEGER NOT NULL DEFAULT 0, revert TEXT, permission TEXT, agent TEXT, model TEXT,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_compacting INTEGER, time_archived INTEGER
  );
  CREATE TABLE message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
  );
  CREATE TABLE part (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX part_session_step_finish_idx ON part (session_id)
    WHERE json_valid(data) AND json_extract(data, '$.type') = 'step-finish';
  CREATE TABLE session_message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
  );`);
  let sequence = 0;
  const helpers = {
    session(id: string, options: { directory?: string; model?: { id: string; providerID: string }; created: string; cost?: number; tokens?: Tokens }) {
      const tokens = options.tokens ?? noTokens;
      const created = Date.parse(options.created);
      db.prepare(`INSERT INTO session (id, project_id, slug, directory, title, version, cost, tokens_input, tokens_output,
        tokens_reasoning, tokens_cache_read, tokens_cache_write, model, time_created, time_updated)
        VALUES (?, 'project', ?, ?, 'Private session title', '7.8.3', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, id, options.directory ?? "/home/user/code/project-a", options.cost ?? 0, tokens.input, tokens.output,
        tokens.reasoning, tokens.cache.read, tokens.cache.write, options.model ? JSON.stringify(options.model) : null, created, created);
    },
    assistant(sessionId: string, id: string, options: { created: string; modelID?: string; providerID?: string; cost?: number; tokens?: Tokens }) {
      const created = Date.parse(options.created);
      db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(id, sessionId, created, created, JSON.stringify({
        role: "assistant",
        time: { created },
        parentID: `${id}-user`,
        modelID: options.modelID,
        providerID: options.providerID,
        mode: "code",
        agent: "code",
        path: { cwd: "/home/user/code/project-a", root: "/home/user/code/project-a" },
        cost: options.cost ?? 0,
        tokens: options.tokens ?? noTokens,
      }));
    },
    text(sessionId: string, messageId: string, at: string, body: string) {
      const time = Date.parse(at);
      db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(`prt_${++sequence}`, messageId, sessionId, time, time,
        JSON.stringify({ type: "text", text: body, time: { start: time, end: time } }));
    },
    step(sessionId: string, messageId: string, at: string, options: { cost: number; tokens: Tokens; model?: { providerID: string; modelID: string }; legacy?: boolean }) {
      const end = Date.parse(at);
      db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(`prt_${++sequence}`, messageId, sessionId, end, end, JSON.stringify({
        type: "step-finish",
        reason: "stop",
        snapshot: "abc123",
        ...(options.legacy ? {} : { time: { start: end - 1_000, end, elapsed: 1_000 } }),
        ...(options.model ? { model: options.model } : {}),
        tokens: { total: 0, ...options.tokens },
        cost: options.cost,
      }));
    },
    // Session.fork: a new session created at fork time receives copies of the
    // source's messages and parts under new IDs. Copies keep their data
    // (including message `time.created` and step timing) except for zeroed
    // costs; part rows are stamped with the fork's event time.
    fork(sourceId: string, targetId: string, at: string, directory: string) {
      helpers.session(targetId, { created: at, directory });
      const forked = Date.parse(at);
      const messages = db.prepare("SELECT * FROM message WHERE session_id = ? ORDER BY id").all(sourceId) as Array<{ id: string; time_created: number; data: string }>;
      for (const message of messages) {
        const id = `${targetId}-${message.id}`;
        const data = JSON.parse(message.data);
        db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(id, targetId, message.time_created, forked,
          JSON.stringify(data.role === "assistant" ? { ...data, cost: 0 } : data));
        const parts = db.prepare("SELECT * FROM part WHERE message_id = ? ORDER BY id").all(message.id) as Array<{ data: string }>;
        for (const part of parts) {
          const copy = JSON.parse(part.data);
          db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(`prt_${++sequence}`, id, targetId, forked, forked,
            JSON.stringify(copy.type === "step-finish" ? { ...copy, cost: 0 } : copy));
        }
      }
    },
    deleteSession(id: string) {
      db.prepare("DELETE FROM part WHERE session_id = ?").run(id);
      db.prepare("DELETE FROM message WHERE session_id = ?").run(id);
      db.prepare("DELETE FROM session WHERE id = ?").run(id);
    },
    v2Assistant(sessionId: string, id: string, at: string, tokens: Tokens) {
      const completed = Date.parse(at);
      const created = completed - 1_000;
      // The v2 runner publishes Step.Ended with `cost: 0`.
      db.prepare("INSERT INTO session_message VALUES (?, ?, 'assistant', ?, ?, ?, ?)").run(id, sessionId, ++sequence, created, completed, JSON.stringify({
        agent: "code", model: { id: "v2-model", providerID: "test-provider" }, time: { created, completed }, content: [], cost: 0, tokens,
      }));
    },
    v2User(sessionId: string, id: string, at: string) {
      const time = Date.parse(at);
      db.prepare("INSERT INTO session_message VALUES (?, ?, 'user', ?, ?, ?, ?)").run(id, sessionId, ++sequence, time, time,
        JSON.stringify({ text: "private prompt", time: { created: time } }));
    },
    close: () => db.close(),
  };
  return helpers;
}

async function scan(dbPath: string, sinceDay = "2026-08-01", env?: NodeJS.ProcessEnv) {
  const script = compressedKilocodeCollectorScript({ agentId: "kilocode", dbPaths: [dbPath], sinceDay });
  expect(script.length).toBeLessThan(9_000);
  const { stdout } = await execFileAsync(process.execPath, ["-e", script], { maxBuffer: 2 * 1024 * 1024, env: { ...process.env, TZ: "UTC", XDG_DATA_HOME: "", APPDATA: "", HOME: join(tmpdir(), "nonexistent-kilo-test-" + Math.random().toString(36).slice(2)), ...env } });
  return extractHostJsonScan(stdout.replace(/\n/g, "\r\n"));
}

const tokens = (input: number, output: number, reasoning = 0, read = 0, write = 0): Tokens => ({ input, output, reasoning, cache: { read, write } });

afterEach(async () => {
  resetPricingCatalog();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("kilocode SQLite collector", () => {
  it("sums step-finish usage, keeping Kilo's already-uncached input and counting reasoning as output", async () => {
    const directory = await temporaryDirectory();
    const dbPath = join(directory, "kilo.db");
    const db = seedKilocodeDb(dbPath);
    db.session("ses-1", { created: "2026-10-05T09:00:00Z" });
    db.assistant("ses-1", "msg-1", { created: "2026-10-05T09:00:00Z", modelID: "test-model", providerID: "test-provider" });
    db.text("ses-1", "msg-1", "2026-10-05T09:00:01Z", "private message");
    db.step("ses-1", "msg-1", "2026-10-05T09:00:02Z", { cost: 0, tokens: tokens(1000, 50, 100, 500, 20) });
    db.step("ses-1", "msg-1", "2026-10-05T09:00:03Z", { cost: 0, tokens: tokens(200, 10, 5, 300, 0) });
    db.close();

    const result = await scan(dbPath);
    expect(result).toMatchObject({ agentId: "kilocode", fileCount: 1, failureCount: 0 });
    expect(result.rows).toEqual([{
      day: "2026-10-05",
      modelProviderId: "test-provider",
      model: "test-model",
      project: "project-a",
      loggedCostUsd: null,
      uncachedInputTokens: 1200,
      cachedInputTokens: 800,
      cacheWriteTokens: 20,
      outputTokens: 165,
    }]);
    expect(JSON.stringify(result)).not.toMatch(/private|abc123/i);
  });

  it("counts each v1 and v2 step once and ignores the derived session and message totals", async () => {
    const directory = await temporaryDirectory();
    const dbPath = join(directory, "kilo.db");
    const db = seedKilocodeDb(dbPath);
    const step = tokens(100, 10, 0, 40, 0);
    // The session counters and message total repeat the step; the message
    // total also absorbs subagent spend.
    db.session("ses-1", { created: "2026-10-05T09:00:00Z", model: { id: "test-model", providerID: "test-provider" }, cost: 9, tokens: step });
    db.assistant("ses-1", "msg-1", { created: "2026-10-05T09:00:00Z", modelID: "test-model", providerID: "test-provider", cost: 9, tokens: step });
    db.step("ses-1", "msg-1", "2026-10-05T09:00:02Z", { cost: 0.25, tokens: step });
    // A session with counters but no persisted steps contributes nothing.
    db.session("ses-totals-only", { created: "2026-10-05T10:00:00Z", cost: 5, tokens: tokens(5000, 500) });
    // Steps run by the v2 engine exist only in session_message.
    db.session("ses-v2", { created: "2026-10-05T11:00:00Z", directory: "/home/user/code/project-v2" });
    db.v2User("ses-v2", "msg-v2-user", "2026-10-05T11:00:00Z");
    db.v2Assistant("ses-v2", "msg-v2-step-1", "2026-10-05T11:00:05Z", tokens(300, 30, 3, 70, 7));
    db.v2Assistant("ses-v2", "msg-v2-step-2", "2026-10-05T11:00:09Z", tokens(20, 2, 0, 400, 0));
    db.close();

    const result = await scan(dbPath);
    expect(result.rows).toEqual([
      expect.objectContaining({ model: "test-model", project: "project-a", loggedCostUsd: 0.25, uncachedInputTokens: 100, cachedInputTokens: 40, outputTokens: 10 }),
      expect.objectContaining({ model: "v2-model", project: "project-v2", loggedCostUsd: null, uncachedInputTokens: 320, cachedInputTokens: 470, cacheWriteTokens: 7, outputTokens: 35 }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(/private/i);
  });

  it("counts distinct step-finish parts even when their counters are identical", async () => {
    const directory = await temporaryDirectory();
    const dbPath = join(directory, "kilo.db");
    const db = seedKilocodeDb(dbPath);
    db.session("ses-1", { created: "2026-10-05T09:00:00Z" });
    db.assistant("ses-1", "msg-1", { created: "2026-10-05T09:00:00Z", modelID: "test-model", providerID: "test-provider" });
    db.step("ses-1", "msg-1", "2026-10-05T09:00:02Z", { cost: 0, tokens: tokens(10, 1), legacy: true });
    db.step("ses-1", "msg-1", "2026-10-05T09:00:02Z", { cost: 0, tokens: tokens(10, 1), legacy: true });
    db.close();

    const result = await scan(dbPath);
    expect(result.rows).toEqual([expect.objectContaining({ uncachedInputTokens: 20, outputTokens: 2 })]);
  });

  it("counts forked history once, in its source session, while counting new work in forks", async () => {
    const directory = await temporaryDirectory();
    const dbPath = join(directory, "kilo.db");
    const db = seedKilocodeDb(dbPath);
    db.session("ses-source", { created: "2026-10-01T09:00:00Z" });
    db.assistant("ses-source", "msg-1", { created: "2026-10-01T09:00:00Z", modelID: "test-model", providerID: "test-provider" });
    db.step("ses-source", "msg-1", "2026-10-01T09:00:02Z", { cost: 0.5, tokens: tokens(1000, 100, 10, 500, 50) });
    db.step("ses-source", "msg-1", "2026-10-01T09:00:04Z", { cost: 0, tokens: tokens(200, 20), legacy: true });
    // Fork into another project; then do new (free) work there.
    db.fork("ses-source", "ses-fork", "2026-10-03T09:00:00Z", "/home/user/code/forked");
    db.assistant("ses-fork", "msg-2", { created: "2026-10-03T10:00:00Z", modelID: "test-model", providerID: "test-provider" });
    db.step("ses-fork", "msg-2", "2026-10-03T10:00:02Z", { cost: 0, tokens: tokens(30, 3) });
    // A fork of the fork, whose own new work is priced.
    db.fork("ses-fork", "ses-fork-2", "2026-10-04T09:00:00Z", "/home/user/code/forked-again");
    db.assistant("ses-fork-2", "msg-3", { created: "2026-10-04T10:00:00Z", modelID: "test-model", providerID: "test-provider" });
    db.step("ses-fork-2", "msg-3", "2026-10-04T10:00:02Z", { cost: 0.25, tokens: tokens(40, 4) });
    db.close();

    const result = await scan(dbPath);
    expect(result.rows.map((row) => [row.day, row.project, row.loggedCostUsd, row.uncachedInputTokens, row.outputTokens])).toEqual([
      ["2026-10-01", "project-a", null, 200, 20],
      ["2026-10-01", "project-a", 0.5, 1000, 110],
      ["2026-10-03", "forked", null, 30, 3],
      ["2026-10-04", "forked-again", 0.25, 40, 4],
    ]);
  });

  it("stops counting forked history once its source session is deleted", async () => {
    // The copies carry no link to their source, so they are skipped either way;
    // this matches Kilo dropping a deleted session's own usage.
    const directory = await temporaryDirectory();
    const dbPath = join(directory, "kilo.db");
    const db = seedKilocodeDb(dbPath);
    db.session("ses-source", { created: "2026-10-01T09:00:00Z" });
    db.assistant("ses-source", "msg-1", { created: "2026-10-01T09:00:00Z", modelID: "test-model", providerID: "test-provider" });
    db.step("ses-source", "msg-1", "2026-10-01T09:00:02Z", { cost: 0.5, tokens: tokens(1000, 100) });
    db.fork("ses-source", "ses-fork", "2026-10-03T09:00:00Z", "/home/user/code/forked");
    db.deleteSession("ses-source");
    db.assistant("ses-fork", "msg-2", { created: "2026-10-03T10:00:00Z", modelID: "test-model", providerID: "test-provider" });
    db.step("ses-fork", "msg-2", "2026-10-03T10:00:02Z", { cost: 0, tokens: tokens(30, 3) });
    db.close();

    const result = await scan(dbPath);
    expect(result.rows.map((row) => [row.day, row.project, row.uncachedInputTokens])).toEqual([["2026-10-03", "forked", 30]]);
  });

  it("attributes resumed sessions to each step's local day, including old sessions with recent usage", async () => {
    const directory = await temporaryDirectory();
    const dbPath = join(directory, "kilo.db");
    const db = seedKilocodeDb(dbPath);
    db.session("ses-old", { created: "2026-06-15T09:00:00Z" });
    db.assistant("ses-old", "msg-june", { created: "2026-06-15T09:00:00Z", modelID: "test-model", providerID: "test-provider" });
    db.step("ses-old", "msg-june", "2026-06-15T09:01:00Z", { cost: 1, tokens: tokens(999, 9) });
    db.assistant("ses-old", "msg-oct-4", { created: "2026-10-04T23:59:00Z", modelID: "test-model", providerID: "test-provider" });
    db.step("ses-old", "msg-oct-4", "2026-10-04T23:59:30Z", { cost: 0.1, tokens: tokens(10, 1) });
    // A long step that started yesterday is dated by when it finished.
    db.step("ses-old", "msg-oct-4", "2026-10-05T00:00:30Z", { cost: 0.2, tokens: tokens(20, 2) });
    db.close();

    const result = await scan(dbPath);
    expect(result.rows.map((row) => [row.day, row.uncachedInputTokens, row.loggedCostUsd])).toEqual([
      ["2026-10-04", 10, 0.1],
      ["2026-10-05", 20, 0.2],
    ]);
  });

  it("attributes each step to the model that served it, not the session's current model", async () => {
    const directory = await temporaryDirectory();
    const dbPath = join(directory, "kilo.db");
    const db = seedKilocodeDb(dbPath);
    db.session("ses-1", { created: "2026-10-05T09:00:00Z", model: { id: "model-b", providerID: "provider-b" } });
    db.assistant("ses-1", "msg-a", { created: "2026-10-05T09:00:00Z", modelID: "model-a", providerID: "provider-a" });
    db.step("ses-1", "msg-a", "2026-10-05T09:00:01Z", { cost: 0, tokens: tokens(100, 10) });
    db.assistant("ses-1", "msg-b", { created: "2026-10-05T10:00:00Z", modelID: "model-b", providerID: "provider-b" });
    db.step("ses-1", "msg-b", "2026-10-05T10:00:01Z", { cost: 0, tokens: tokens(200, 20) });
    // Kilo Auto records the routed model on the step itself.
    db.assistant("ses-1", "msg-auto", { created: "2026-10-05T11:00:00Z", modelID: "kilo-auto/balanced", providerID: "kilo" });
    db.step("ses-1", "msg-auto", "2026-10-05T11:00:01Z", { cost: 0.3, tokens: tokens(300, 30), model: { providerID: "kilo", modelID: "anthropic/claude-sonnet-4.5" } });
    db.close();

    const result = await scan(dbPath);
    expect(result.rows.map((row) => [row.modelProviderId, row.model, row.uncachedInputTokens])).toEqual([
      ["kilo", "anthropic/claude-sonnet-4.5", 300],
      ["provider-a", "model-a", 100],
      ["provider-b", "model-b", 200],
    ]);
  });

  it("keeps logged and unpriced steps in separate buckets so both are costed", async () => {
    setPricingCatalog({ "test-provider": { models: { "test-model": { id: "test-model", cost: { input: 1, output: 1 } } } } }, "test");
    const directory = await temporaryDirectory();
    const dbPath = join(directory, "kilo.db");
    const db = seedKilocodeDb(dbPath);
    db.session("ses-1", { created: "2026-10-05T09:00:00Z" });
    db.assistant("ses-1", "msg-1", { created: "2026-10-05T09:00:00Z", modelID: "test-model", providerID: "test-provider" });
    db.step("ses-1", "msg-1", "2026-10-05T09:00:01Z", { cost: 0.5, tokens: tokens(1_000_000, 0) });
    db.step("ses-1", "msg-1", "2026-10-05T09:00:02Z", { cost: 0.25, tokens: tokens(10, 0) });
    db.step("ses-1", "msg-1", "2026-10-05T09:00:03Z", { cost: 0, tokens: tokens(1_000_000, 0) });
    db.close();

    const result = await scan(dbPath);
    expect(result.rows.map((row) => [row.loggedCostUsd, row.uncachedInputTokens])).toEqual([
      [null, 1_000_000],
      [0.75, 1_000_010],
    ]);
    const records = parseHostUsageAggregates(JSON.stringify(result.rows), "kilocode", { machineId: "m", machineName: "M" });
    expect(new Set(records.map((record) => record.eventKey)).size).toBe(2);
    expect(records.reduce((sum, record) => sum + record.costUsd, 0)).toBeCloseTo(1.75, 9);
  });

  it.each([
    ["Pacific/Auckland", "2026-08-01T00:30:00+12:00", "2026-07-31T23:30:00+12:00"],
    ["America/Los_Angeles", "2026-08-01T00:30:00-07:00", "2026-07-31T23:30:00-07:00"],
  ])("applies sinceDay at host-local midnight in %s", async (timeZone, inside, outside) => {
    const directory = await temporaryDirectory();
    const dbPath = join(directory, "kilo.db");
    const db = seedKilocodeDb(dbPath);
    db.session("ses-1", { created: "2026-07-31T00:00:00Z" });
    db.assistant("ses-1", "msg-1", { created: "2026-07-31T00:00:00Z", modelID: "test-model", providerID: "test-provider" });
    db.step("ses-1", "msg-1", inside, { cost: 0, tokens: tokens(100, 1) });
    db.step("ses-1", "msg-1", outside, { cost: 0, tokens: tokens(7, 1) });
    db.close();

    const result = await scan(dbPath, "2026-08-01", { TZ: timeZone });
    expect(result.rows).toEqual([expect.objectContaining({ day: "2026-08-01", uncachedInputTokens: 100 })]);
  });

  it("dates legacy step-finish parts without time.end by their row timestamp", async () => {
    const directory = await temporaryDirectory();
    const dbPath = join(directory, "kilo.db");
    const db = seedKilocodeDb(dbPath);
    db.session("ses-1", { created: "2026-07-01T09:00:00Z" });
    db.assistant("ses-1", "msg-1", { created: "2026-07-01T09:00:00Z", modelID: "test-model", providerID: "test-provider" });
    db.step("ses-1", "msg-1", "2026-07-01T09:00:01Z", { cost: 0, tokens: tokens(5, 1), legacy: true });
    db.step("ses-1", "msg-1", "2026-10-03T09:00:01Z", { cost: 0, tokens: tokens(50, 1), legacy: true });
    db.close();

    const result = await scan(dbPath);
    expect(result.rows).toEqual([expect.objectContaining({ day: "2026-10-03", uncachedInputTokens: 50 })]);
  });

  it("reports an empty scan when kilo.db does not exist", async () => {
    const directory = await temporaryDirectory();
    const result = await scan(join(directory, "kilo.db"), "2026-08-01", { HOME: join(directory, "nonexistent") });
    expect(result).toMatchObject({ agentId: "kilocode", fileCount: 0, failureCount: 0, rows: [] });
  });

  it("labels steps missing model or working directory as unknown", async () => {
    const directory = await temporaryDirectory();
    const dbPath = join(directory, "kilo.db");
    const db = seedKilocodeDb(dbPath);
    db.session("ses-empty", { created: "2026-10-05T09:00:00Z", directory: "" });
    db.assistant("ses-empty", "msg-empty", { created: "2026-10-05T09:00:00Z" });
    db.step("ses-empty", "msg-empty", "2026-10-05T09:00:01Z", { cost: 0, tokens: tokens(5, 5, 5) });
    db.session("ses-orphan", { created: "2026-10-05T09:00:00Z", directory: "/home/user/code/orphan" });
    db.step("ses-orphan", "msg-missing", "2026-10-05T09:00:01Z", { cost: 0, tokens: tokens(5, 5, 5) });
    db.close();

    const result = await scan(dbPath);
    expect(result.rows).toEqual([
      expect.objectContaining({ modelProviderId: "kilo", model: "kilocode-unknown", project: "orphan", uncachedInputTokens: 5, outputTokens: 10 }),
      expect.objectContaining({ modelProviderId: "kilo", model: "kilocode-unknown", project: "Unknown", uncachedInputTokens: 5, outputTokens: 10 }),
    ]);
  });

  it("discovers the database under XDG_DATA_HOME", async () => {
    const directory = await temporaryDirectory();
    const xdgData = join(directory, "xdg", "kilo");
    const dbPath = join(xdgData, "kilo.db");
    await mkdir(xdgData, { recursive: true });
    const db = seedKilocodeDb(dbPath);
    db.session("ses-1", { created: "2026-10-05T09:00:00Z", directory: "/work/project-a" });
    db.assistant("ses-1", "msg-1", { created: "2026-10-05T09:00:00Z", modelID: "test-model", providerID: "test-provider" });
    db.step("ses-1", "msg-1", "2026-10-05T09:00:01Z", { cost: 0, tokens: tokens(50, 10, 10, 50) });
    db.close();

    const result = await scan(join(directory, "absent", "kilo.db"), "2026-08-01", { XDG_DATA_HOME: join(directory, "xdg") });
    expect(result.rows).toEqual([expect.objectContaining({ project: "project-a", uncachedInputTokens: 50, cachedInputTokens: 50, outputTokens: 20 })]);
  });
});
