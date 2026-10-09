import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

// BB supplies this identity function when it loads the production bundle. Keep
// the bundle itself untouched: these tests must exercise its actual commands.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@bb/plugin-sdk" || specifier === "@get-bb/plugin-sdk") {
      return { shortCircuit: true, url: "data:text/javascript,export const defineRpcContract = value => value;" };
    }
    return nextResolve(specifier, context);
  },
});
const { ampUsageCommand, jsonAgentCommand, devinCommand, kilocodeCommand, syncGrokLimits } = await import("../dist/server.js");
hooks.deregister();

function temporaryHome(t) {
  const home = mkdtempSync(join(tmpdir(), "bb-usage-built-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function run(command, home, env = {}) {
  return execFileSync("sh", ["-c", command], {
    encoding: "utf8", timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, HOME: home, XDG_DATA_HOME: "", APPDATA: "", NODE_OPTIONS: "", TZ: "UTC", ...env },
  });
}

function scan(output) {
  const encoded = output.match(/__BB_USAGE_SCAN_BEGIN__\s+([A-Za-z0-9+/=]+)\s+__BB_USAGE_SCAN_END__/)?.[1];
  assert.ok(encoded, `Missing scan result: ${output}`);
  return JSON.parse(gunzipSync(Buffer.from(encoded, "base64")));
}

function ampScan(output) {
  const encoded = output.match(/__BB_AMP_USAGE_SCAN_BEGIN__\s+([A-Za-z0-9+/=]+)\s+__BB_AMP_USAGE_SCAN_END__/)?.[1];
  assert.ok(encoded, `Missing Amp scan result: ${output}`);
  return JSON.parse(gunzipSync(Buffer.from(encoded, "base64")));
}

test("production Amp command executes without bundled helper references", (t) => {
  const home = temporaryHome(t);
  const bin = join(home, "bin");
  mkdirSync(bin);
  const amp = join(bin, "amp");
  writeFileSync(amp, "#!/bin/sh\nprintf '[]\\n'\n");
  chmodSync(amp, 0o755);
  const result = ampScan(run(ampUsageCommand(home), home, { PATH: `${bin}:${process.env.PATH}` }));
  assert.equal(result.agentId, "amp");
  assert.equal(result.failureCount, 0);
  assert.deepEqual(result.threads, []);
});

test("production JSON commands scan logs and reuse the metadata cache", (t) => {
  const home = temporaryHome(t);
  const root = join(home, "sessions");
  mkdirSync(root);
  writeFileSync(join(root, "rollout-test.jsonl"), [
    { type: "session_meta", payload: { id: "test-session", cwd: "/work/project", prompt: "private prompt" } },
    { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
    { timestamp: "2026-09-24T12:00:00Z", type: "event_msg", payload: { type: "token_count", info: {
      last_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20 },
    } } },
  ].map((row) => JSON.stringify(row)).join("\n"));
  const command = jsonAgentCommand({ agentId: "codex", roots: [root], cachePath: join(home, "cache.json"), sinceDay: "2026-09-01" });
  const first = scan(run(command, home));
  assert.equal(first.failureCount, 0);
  assert.equal(first.changedFileCount, 1);
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0].day, "2026-09-24");
  assert.equal(first.rows[0].uncachedInputTokens, 40);
  assert.equal(first.rows[0].cachedInputTokens, 60);
  assert.equal(first.rows[0].outputTokens, 20);
  assert.doesNotMatch(JSON.stringify(first), /private prompt/);
  const cached = scan(run(command, home));
  assert.equal(cached.reusedFileCount, 1);
  assert.deepEqual(cached.rows, first.rows);
});

test("production JSON commands accept absent roots for every JSON agent", (t) => {
  const home = temporaryHome(t);
  for (const agentId of ["codex", "claude", "copilot", "freebuff", "dsh", "fx", "grok", "pi", "prime", "antigravity", "thaura"]) {
    const result = scan(run(jsonAgentCommand({
      agentId, roots: [join(home, "absent")], cachePath: join(home, `${agentId}.json`), sinceDay: "2026-09-01",
    }), home));
    assert.equal(result.agentId, agentId);
    assert.equal(result.failureCount, 0);
    assert.deepEqual(result.rows, []);
  }
});

test("production Copilot collection needs no CLI binary or configuration", (t) => {
  const home = temporaryHome(t);
  const bin = join(home, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  // The generated command gets only Node on PATH: there is no Copilot CLI,
  // package manager, credential helper, or configuration in this fixture.
  const env = { ...process.env, HOME: home, PATH: bin, NODE_OPTIONS: "", TZ: "UTC" };
  execFileSync("/bin/sh", ["-c", "if command -v copilot >/dev/null 2>&1; then exit 1; fi"], { env });
  const root = join(home, ".copilot/session-state");
  const command = jsonAgentCommand({ agentId: "copilot", roots: [root], cachePath: join(home, "cache/copilot.json"), sinceDay: "2026-09-01" });
  const collect = () => scan(execFileSync("/bin/sh", ["-c", command], {
    env, encoding: "utf8", timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
  }));
  for (const createEmptyRoot of [false, true]) {
    if (createEmptyRoot) mkdirSync(root, { recursive: true });
    const result = collect();
    assert.equal(result.failureCount, 0);
    assert.equal(result.error, null);
    assert.equal(result.fileCount, 0);
    assert.deepEqual(result.rows, []);
  }
  // Retained history also remains readable after the CLI is uninstalled.
  writeFileSync(join(root, "events.jsonl"), JSON.stringify({
    type: "session.shutdown", id: "finished-session", timestamp: "2026-09-24T12:00:00Z",
    data: { modelMetrics: { "unknown-model": { usage: {
      inputTokens: 100, cacheReadTokens: 60, cacheWriteTokens: 5, outputTokens: 20,
    } } } },
  }));
  const historical = collect();
  assert.equal(historical.failureCount, 0);
  assert.equal(historical.rows.length, 1);
  assert.equal(historical.rows[0].uncachedInputTokens, 35);
  assert.equal(historical.rows[0].cachedInputTokens, 60);
  assert.equal(historical.rows[0].cacheWriteTokens, 5);
  assert.equal(historical.rows[0].outputTokens, 20);
});

test("production Devin command queries a real SQLite fixture", (t) => {
  const home = temporaryHome(t);
  assert.deepEqual(scan(run(devinCommand(home), home)).rows, []);
  const dbPath = join(home, ".local/share/devin/cli/sessions.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT, model TEXT, metadata TEXT);
      CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY, session_id TEXT, node_id INTEGER, chat_message TEXT, created_at INTEGER, metadata TEXT);`);
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run("session-1", "/work/project", "swe-2-max", null);
    db.prepare("INSERT INTO message_nodes (session_id, node_id, chat_message, created_at) VALUES (?, ?, ?, ?)").run(
      "session-1", 1, JSON.stringify({ role: "assistant", content: "private message", metadata: {
        request_id: "request-1", created_at: new Date().toISOString(),
        metrics: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 60, cache_creation_tokens: 5 },
      } }), Math.floor(Date.now() / 1000),
    );
  } finally { db.close(); }
  const result = scan(run(devinCommand(home), home));
  assert.equal(result.failureCount, 0);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].uncachedInputTokens, 100);
  assert.equal(result.rows[0].cachedInputTokens, 60);
  assert.equal(result.rows[0].cacheWriteTokens, 5);
  assert.equal(result.rows[0].outputTokens, 20);
  assert.doesNotMatch(JSON.stringify(result), /private message/);
});

test("production Kilo Code command queries its local session database", (t) => {
  const home = temporaryHome(t);
  // No database yet: an empty, non-failing scan rather than a sync error.
  assert.deepEqual(scan(run(kilocodeCommand(home), home)).rows, []);
  const dbPath = join(home, ".local/share/kilo/kilo.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, model TEXT, cost REAL,
      tokens_input INTEGER, tokens_output INTEGER, time_created INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER, data TEXT);`);
    const now = Date.now();
    // Lifetime counters and the current session model are derived/mutable;
    // only the persisted steps are usage.
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "ses", "/work/project", JSON.stringify({ id: "later-model", providerID: "kilo" }), 99, 99999, 99999, now - 90 * 86_400_000,
    );
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("msg", "ses", now, JSON.stringify({
      role: "assistant", modelID: "kilo-auto/free", providerID: "kilo", cost: 99, time: { created: now },
    }));
    const step = (id, cost, input, output, reasoning, read, write) => db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run(
      id, "msg", "ses", now, JSON.stringify({ type: "step-finish", reason: "stop", time: { start: now - 1, end: now, elapsed: 1 },
        cost, tokens: { input, output, reasoning, cache: { read, write } } }),
    );
    step("prt-1", 0.42, 800, 350, 25, 400, 10);
    step("prt-2", 0, 100, 5, 0, 0, 0);
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run("prt-3", "msg", "ses", now, JSON.stringify({ type: "text", text: "private message" }));
    db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)").run("v2", "ses", "assistant", now, JSON.stringify({
      model: { id: "v2-model", providerID: "kilo" }, time: { created: now, completed: now }, cost: 0,
      tokens: { input: 30, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
    }));
  } finally { db.close(); }
  const result = scan(run(kilocodeCommand(home), home));
  assert.equal(result.agentId, "kilocode");
  assert.equal(result.failureCount, 0);
  assert.doesNotMatch(JSON.stringify(result), /private message/);
  const rows = result.rows.map(({ model, project, loggedCostUsd, uncachedInputTokens, cachedInputTokens, cacheWriteTokens, outputTokens }) =>
    [model, project, loggedCostUsd, uncachedInputTokens, cachedInputTokens, cacheWriteTokens, outputTokens]);
  // Kilo's step input is already uncached and reasoning counts as output; the
  // priced and unpriced steps stay in separate buckets.
  assert.deepEqual(rows, [
    ["kilo-auto/free", "project", null, 100, 0, 0, 5],
    ["kilo-auto/free", "project", 0.42, 800, 400, 10, 375],
    ["v2-model", "project", null, 30, 0, 0, 3],
  ]);
});

test("production Grok command normalizes billing without bundler helpers", async (t) => {
  const home = temporaryHome(t);
  const authPath = join(home, "auth.json");
  writeFileSync(authPath, JSON.stringify({ "https://accounts.x.ai/sign-in": { key: "test-secret", user_id: "test-user", auth_mode: "oidc" } }));
  const preload = join(home, "fetch.cjs");
  writeFileSync(preload, `global.fetch = async () => new Response(JSON.stringify({
    config: { creditUsagePercent: 25, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' } }
  }));`);
  const warnings = [];
  const writes = [];
  await syncGrokLimits(
    { log: { warn: (message) => warnings.push(message) } },
    { prepare: () => ({ run: (...values) => writes.push(values) }) },
    { id: "test-host", name: "Test" }, AbortSignal.timeout(15_000),
    async (_bb, _machine, command) => run(command, home, { GROK_AUTH_PATH: authPath, NODE_OPTIONS: `--require=${preload}` }),
  );
  assert.deepEqual(warnings, []);
  assert.equal(writes.length, 1);
  const snapshot = JSON.parse(writes[0][2]);
  assert.deepEqual(snapshot.windows, [{ label: "Weekly credits", usedPercent: 25, resetsAt: null }]);
  assert.match(snapshot.accountIdentity, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(writes), /test-secret|test-user/);
});
