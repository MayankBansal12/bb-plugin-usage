import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  compressedHostJsonCollectorScript,
  extractHostJsonScan,
  type HostJsonAgentId,
  type HostJsonScanInput,
} from "./host-json-collector";

function localDay(timestamp: string): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "bb-usage-host-scan-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function scan(agentId: HostJsonAgentId, root: string | string[], cachePath: string, extra?: Partial<HostJsonScanInput>) {
  const script = compressedHostJsonCollectorScript({
    agentId,
    roots: Array.isArray(root) ? root : [root],
    cachePath,
    sinceDay: "2026-08-01",
    ...extra,
  });
  expect(script.length).toBeLessThan(9_000);
  const { stdout } = await execFileAsync(process.execPath, ["-e", script], { maxBuffer: 2 * 1024 * 1024 });
  return extractHostJsonScan(stdout.replace(/\n/g, "\r\n"));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("host JSON usage collector", () => {
  it("streams Codex logs and reuses metadata-only per-file aggregates", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, "sessions");
    const cachePath = join(directory, "cache", "codex.json");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "rollout-test.jsonl"), [
      { timestamp: "2026-08-09T12:00:00Z", type: "session_meta", payload: { id: "session-1", prompt: "must not be cached" } },
      { timestamp: "2026-08-09T12:00:00Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      { timestamp: "2026-08-09T12:00:01Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 5, output_tokens: 20 } } } },
    ].map((value) => JSON.stringify(value)).join("\n"));

    const first = await scan("codex", root, cachePath);
    expect(first).toMatchObject({ fileCount: 1, changedFileCount: 1, reusedFileCount: 0, failureCount: 0 });
    expect(first.rows).toEqual([expect.objectContaining({
      day: localDay("2026-08-09T12:00:00Z"),
      modelProviderId: "openai",
      model: "gpt-5.6-sol",
      uncachedInputTokens: 40,
      cachedInputTokens: 60,
      cacheWriteTokens: 5,
      outputTokens: 20,
    })]);

    const cache = await readFile(cachePath, "utf8");
    expect(cache).not.toContain("must not be cached");
    expect(cache).not.toContain(root);

    const second = await scan("codex", root, cachePath);
    expect(second).toMatchObject({ fileCount: 1, changedFileCount: 0, reusedFileCount: 1, failureCount: 0 });
    expect(second.rows).toEqual(first.rows);

    await rm(root, { recursive: true, force: true });
    await writeFile(root, "not a directory");
    const partial = await scan("codex", root, cachePath);
    expect(partial).toMatchObject({ fileCount: 0, failureCount: 1 });
    expect(partial.rows).toEqual(first.rows);
  });

  it("attributes sessions under the account root to each Codex profile", async () => {
    const directory = await temporaryDirectory();
    const home = join(directory, "home");
    const root = join(home, ".codex", "sessions");
    const accountRoot = join(home, ".codex-profiles");
    const cachePath = join(directory, "cache", "codex.json");
    const rollout = (id: string, inputTokens: number) => [
      { timestamp: "2026-08-09T12:00:00Z", type: "session_meta", payload: { id, cwd: `/work/${id}` } },
      { timestamp: "2026-08-09T12:00:00Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      { timestamp: "2026-08-09T12:00:01Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: inputTokens, cached_input_tokens: 0, output_tokens: 5 } } } },
    ].map((value) => JSON.stringify(value)).join("\n");
    await mkdir(root, { recursive: true });
    await mkdir(join(accountRoot, "saiens", "sessions", "2026", "08", "09"), { recursive: true });
    await mkdir(join(accountRoot, "omnidrome", "sessions"), { recursive: true });
    await mkdir(join(accountRoot, "dormant"), { recursive: true });
    await writeFile(join(root, "rollout-main.jsonl"), rollout("main-session", 100));
    await writeFile(join(accountRoot, "saiens", "sessions", "2026", "08", "09", "rollout-extra.jsonl"), rollout("saiens-session", 40));
    await writeFile(join(accountRoot, "omnidrome", "sessions", "rollout-extra.jsonl"), rollout("omnidrome-session", 60));
    await writeFile(join(accountRoot, "saiens", "auth.json"), "{}");

    const first = await scan("codex", root, cachePath, { accountRoot });
    expect(first).toMatchObject({ fileCount: 3, changedFileCount: 3, reusedFileCount: 0, failureCount: 0 });
    const day = localDay("2026-08-09T12:00:00Z");
    expect(first.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ day, model: "gpt-5.6-sol", project: "main-session", uncachedInputTokens: 100 }),
      expect.objectContaining({ day, account: "saiens", project: "saiens-session", uncachedInputTokens: 40 }),
      expect.objectContaining({ day, account: "omnidrome", project: "omnidrome-session", uncachedInputTokens: 60 }),
    ]));
    expect(first.rows.find((row) => row.account === undefined)?.account).toBeUndefined();
    expect(JSON.stringify(first.rows)).not.toContain("dormant");

    const second = await scan("codex", root, cachePath, { accountRoot });
    expect(second).toMatchObject({ fileCount: 3, changedFileCount: 0, reusedFileCount: 3, failureCount: 0 });
    expect(second.rows).toEqual(first.rows);
  });

  it("does not double-count a profile home linked to the primary Codex home", async () => {
    const directory = await temporaryDirectory();
    const home = join(directory, "home");
    const root = join(home, ".codex", "sessions");
    const accountRoot = join(home, ".codex-profiles");
    const cachePath = join(directory, "cache", "codex.json");
    await mkdir(root, { recursive: true });
    await mkdir(accountRoot, { recursive: true });
    await writeFile(join(root, "rollout-main.jsonl"), [
      JSON.stringify({ timestamp: "2026-08-09T12:00:00Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 5 } } } }),
    ].join("\n"));
    await symlink(join(home, ".codex"), join(accountRoot, "alias"), "dir");

    const result = await scan("codex", root, cachePath, { accountRoot });
    expect(result).toMatchObject({ fileCount: 1, failureCount: 0 });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).not.toMatchObject({ account: "alias" });
    expect(result.rows[0]).toMatchObject({ uncachedInputTokens: 100 });
  });

  it.each([
    ["claude", "session.jsonl", {
      type: "assistant", timestamp: "2026-08-09T00:00:00Z",
      message: { id: "message-private", model: "claude-sonnet-5", content: "private", usage: { input_tokens: 40, cache_read_input_tokens: 60, cache_creation_input_tokens: 5, output_tokens: 20 } },
    }, { modelProviderId: "anthropic", uncachedInputTokens: 40, cachedInputTokens: 60, outputTokens: 20 }],
    ["grok", "unified.jsonl", {
      ts: "2026-08-09T00:00:00Z", msg: "shell.turn.inference_done",
      ctx: { model: "grok-4", prompt_tokens: 100, cached_prompt_tokens: 60, completion_tokens: 15, reasoning_tokens: 5 },
    }, { modelProviderId: "xai", uncachedInputTokens: 40, cachedInputTokens: 60, outputTokens: 20 }],
    ["pi", "session.jsonl", {
      type: "message", timestamp: "2026-08-09T00:00:00Z",
      message: { role: "assistant", provider: "google", model: "gemini-2.5-pro", content: "private", usage: { input: 40, cacheRead: 60, cacheWrite: 5, output: 20, cost: { total: 0.01 } } },
    }, { modelProviderId: "google", uncachedInputTokens: 40, cachedInputTokens: 60, outputTokens: 20, loggedCostUsd: 0.01 }],
    ["prime", "session.jsonl", {
      type: "message", timestamp: "2026-08-09T00:00:00Z",
      message: { role: "assistant", provider: "prime-inference", model: "openai/gpt-5.5", content: "private", usage: { input: 40, cacheRead: 60, cacheWrite: 5, output: 20, cost: { total: 0.01 } } },
    }, { modelProviderId: "prime-inference", model: "openai/gpt-5.5", uncachedInputTokens: 40, cachedInputTokens: 60, outputTokens: 20, loggedCostUsd: 0.01 }],
  ] as const)("extracts %s usage without retaining message content", async (agentId, filename, event, expected) => {
    const directory = await temporaryDirectory();
    const root = join(directory, "logs");
    const cachePath = join(directory, "cache", `${agentId}.json`);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, filename), JSON.stringify(event));

    const result = await scan(agentId, root, cachePath);
    expect(result.failureCount).toBe(0);
    expect(result.rows).toEqual([expect.objectContaining(expected)]);
    const cache = await readFile(cachePath, "utf8");
    expect(cache).not.toContain("private");
    expect(cache).not.toContain("message-private");
  });

  it("reads only FX's usage ledger and aggregates its recorded tokens and spend", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, "usage.jsonl");
    const cachePath = join(directory, "cache", "fx.json");
    await writeFile(root, [
      { schema_version: 1, kind: "coverage", status: "partial" },
      { schema_version: 1, kind: "generation", fact: {
        id: "generation-private",
        created_at_ms: Date.parse("2026-08-09T00:00:00Z"),
        model: "zai/glm-5.2",
        input_tokens: 100,
        output_tokens: 15,
        cache_read_tokens: 60,
        cache_write_tokens: 5,
        reasoning_tokens: 5,
        total_cost: 0.015,
      } },
    ].map((value) => JSON.stringify(value)).join("\n"));

    const first = await scan("fx", root, cachePath);
    expect(first).toMatchObject({ fileCount: 1, changedFileCount: 1, reusedFileCount: 0, failureCount: 0 });
    expect(first.rows).toEqual([expect.objectContaining({
      day: localDay("2026-08-09T00:00:00Z"),
      modelProviderId: "zai",
      model: "zai/glm-5.2",
      uncachedInputTokens: 35,
      cachedInputTokens: 60,
      cacheWriteTokens: 5,
      outputTokens: 15,
      loggedCostUsd: 0.015,
    })]);
    const cache = await readFile(cachePath, "utf8");
    expect(cache).not.toContain("generation-private");
    expect(cache).not.toContain(root);

    const second = await scan("fx", root, cachePath);
    expect(second).toMatchObject({ fileCount: 1, changedFileCount: 0, reusedFileCount: 1, failureCount: 0 });
    expect(second.rows).toEqual(first.rows);
  });

  it("streams Antigravity's provider-bridge usage log", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, "usage.jsonl");
    const cachePath = join(directory, "cache", "antigravity.json");
    await writeFile(root, [
      { kind: "coverage", status: "partial" },
      { kind: "generation", fact: {
        created_at_ms: Date.parse("2026-08-09T00:00:00Z"),
        provider: "google",
        model: "gemini-4-ultra-preview",
        input_tokens: 10415,
        output_tokens: 657,
        thinking_tokens: 616,
        cache_read_tokens: 8113,
        total_cost: null,
      } },
    ].map((value) => JSON.stringify(value)).join("\n"));

    const first = await scan("antigravity", root, cachePath);
    expect(first).toMatchObject({ fileCount: 1, changedFileCount: 1, reusedFileCount: 0, failureCount: 0 });
    expect(first.rows).toEqual([expect.objectContaining({
      day: localDay("2026-08-09T00:00:00Z"),
      modelProviderId: "google",
      model: "gemini-4-ultra-preview",
      uncachedInputTokens: 2302,
      cachedInputTokens: 8113,
      cacheWriteTokens: 0,
      outputTokens: 657,
      loggedCostUsd: null,
    })]);

    const second = await scan("antigravity", root, cachePath);
    expect(second).toMatchObject({ fileCount: 1, changedFileCount: 0, reusedFileCount: 1, failureCount: 0 });
    expect(second.rows).toEqual(first.rows);
  });

  it("streams Thaura's usage ledger and prices its flat model rate", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, "usage.jsonl");
    const cachePath = join(directory, "cache", "thaura.json");
    await writeFile(root, [
      { kind: "coverage", status: "partial" },
      { kind: "generation", fact: {
        created_at_ms: Date.parse("2026-08-09T00:00:00Z"),
        model: "thaura",
        input_tokens: 100,
        output_tokens: 15,
        total_cost: null,
      } },
    ].map((value) => JSON.stringify(value)).join("\n"));

    const first = await scan("thaura", root, cachePath);
    expect(first).toMatchObject({ fileCount: 1, changedFileCount: 1, reusedFileCount: 0, failureCount: 0 });
    expect(first.rows).toEqual([expect.objectContaining({
      day: localDay("2026-08-09T00:00:00Z"),
      modelProviderId: "thaura",
      model: "thaura",
      uncachedInputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 15,
      loggedCostUsd: null,
    })]);

    const second = await scan("thaura", root, cachePath);
    expect(second).toMatchObject({ fileCount: 1, changedFileCount: 0, reusedFileCount: 1, failureCount: 0 });
    expect(second.rows).toEqual(first.rows);
  });

  it("keeps recorded and estimated Thaura generations in separate aggregate rows", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, "usage.jsonl");
    const cachePath = join(directory, "cache", "thaura.json");
    await writeFile(root, [
      { kind: "generation", fact: {
        created_at_ms: Date.parse("2026-08-09T00:00:00Z"),
        model: "thaura", input_tokens: 1_000_000, output_tokens: 1_000_000, total_cost: 7, cwd: "/work/app",
      } },
      { kind: "generation", fact: {
        created_at_ms: Date.parse("2026-08-09T01:00:00Z"),
        model: "thaura", input_tokens: 1_000_000, output_tokens: 1_000_000, total_cost: null, cwd: "/work/app",
      } },
    ].map((value) => JSON.stringify(value)).join("\n"));

    const result = await scan("thaura", root, cachePath);
    const day = localDay("2026-08-09T00:00:00Z");
    expect(result.rows.filter((row) => row.day === day)).toHaveLength(2);
    const logged = result.rows.find((row) => row.loggedCostUsd !== null);
    const estimated = result.rows.find((row) => row.loggedCostUsd === null);
    expect(logged).toMatchObject({ loggedCostUsd: 7, uncachedInputTokens: 1_000_000, outputTokens: 1_000_000, project: "app" });
    expect(estimated).toMatchObject({ loggedCostUsd: null, uncachedInputTokens: 1_000_000, outputTokens: 1_000_000, project: "app" });
  });

  it("counts each Claude API response once across repeated rows, files, and cached scans", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, "projects");
    const cachePath = join(directory, "cache", "claude.json");
    await mkdir(root, { recursive: true });
    const repeated = {
      type: "assistant", timestamp: "2026-08-09T00:00:00Z", requestId: "request-1",
      message: { id: "message-1", model: "claude-sonnet-5", content: "private", usage: {
        input_tokens: 40, cache_read_input_tokens: 60, cache_creation_input_tokens: 5, output_tokens: 20,
      } },
    };
    const distinct = {
      type: "assistant", timestamp: "2026-08-09T00:01:00Z", requestId: "request-2",
      message: { id: "message-2", model: "claude-sonnet-5", usage: {
        input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 2, output_tokens: 8,
      } },
    };
    await writeFile(join(root, "session-a.jsonl"), [repeated, repeated, distinct].map((value) => JSON.stringify(value)).join("\n"));
    await writeFile(join(root, "session-copy.jsonl"), JSON.stringify(repeated));

    const first = await scan("claude", root, cachePath);
    expect(first).toMatchObject({ fileCount: 2, changedFileCount: 2, reusedFileCount: 0, failureCount: 0 });
    expect(first.rows).toEqual([expect.objectContaining({
      day: localDay("2026-08-09T00:00:00Z"),
      modelProviderId: "anthropic",
      model: "claude-sonnet-5",
      uncachedInputTokens: 50,
      cachedInputTokens: 80,
      cacheWriteTokens: 7,
      outputTokens: 28,
    })]);

    const second = await scan("claude", root, cachePath);
    expect(second).toMatchObject({ fileCount: 2, changedFileCount: 0, reusedFileCount: 2, failureCount: 0 });
    expect(second.rows).toEqual(first.rows);
  });

  it("uses the largest counters when repeated Claude rows contain an incremental snapshot", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, "projects");
    const cachePath = join(directory, "cache", "claude.json");
    await mkdir(root, { recursive: true });
    const event = (outputTokens: number) => ({
      type: "assistant", timestamp: "2026-08-09T00:00:00Z",
      message: { id: "message-1", model: "claude-sonnet-5", usage: {
        input_tokens: 40, cache_read_input_tokens: 60, cache_creation_input_tokens: 5, output_tokens: outputTokens,
      } },
    });
    await writeFile(join(root, "session.jsonl"), [event(5), event(20)].map((value) => JSON.stringify(value)).join("\n"));

    const result = await scan("claude", root, cachePath);
    expect(result.rows).toEqual([expect.objectContaining({
      uncachedInputTokens: 40,
      cachedInputTokens: 60,
      cacheWriteTokens: 5,
      outputTokens: 20,
    })]);
  });

  it("counts Prime recursive-agent transcripts once and ignores parent attribution aggregates", async () => {
    const directory = await temporaryDirectory();
    const sessionsRoot = join(directory, "sessions");
    const artifactsRoot = join(directory, "session-artifacts");
    const childRoot = join(artifactsRoot, "root-session", "sub-reviewer");
    const cachePath = join(directory, "cache", "prime.json");
    await mkdir(sessionsRoot, { recursive: true });
    await mkdir(childRoot, { recursive: true });
    await writeFile(join(sessionsRoot, "root-session.jsonl"), [
      { type: "session", version: 3, id: "root-session", timestamp: "2026-08-09T00:00:00Z" },
      { type: "message", id: "parent-message", timestamp: "2026-08-09T00:00:01Z", message: {
        role: "assistant", provider: "google", model: "gemini-2.5-pro", content: "private parent content",
        usage: { input: 40, cacheRead: 10, cacheWrite: 5, output: 5, cost: { total: 0.01 } },
      } },
      { type: "child_usage_attributed", id: "attribution", parentId: "parent-message", timestamp: "2026-08-09T00:00:03Z",
        targetId: "parent-message",
        childUsage: { input: 30, cacheRead: 0, cacheWrite: 0, output: 15, cost: { total: 0.02 } },
        aggregateUsage: { input: 70, cacheRead: 10, cacheWrite: 5, output: 20, cost: { total: 0.03 } },
      },
    ].map((value) => JSON.stringify(value)).join("\n"));
    await writeFile(join(childRoot, "child-session.jsonl"), [
      { type: "session", version: 3, id: "child-session", timestamp: "2026-08-09T00:00:01Z" },
      { type: "message", id: "child-message", timestamp: "2026-08-09T00:00:02Z", message: {
        role: "assistant", provider: "google", model: "gemini-2.5-pro", content: "private child content",
        usage: { input: 30, cacheRead: 0, cacheWrite: 0, output: 15, cost: { total: 0.02 } },
      } },
    ].map((value) => JSON.stringify(value)).join("\n"));

    const result = await scan("prime", [sessionsRoot, artifactsRoot], cachePath);
    expect(result).toMatchObject({ agentId: "prime", fileCount: 2, failureCount: 0 });
    expect(result.rows).toEqual([expect.objectContaining({
      modelProviderId: "google",
      model: "gemini-2.5-pro",
      uncachedInputTokens: 70,
      cachedInputTokens: 10,
      cacheWriteTokens: 5,
      outputTokens: 20,
      loggedCostUsd: 0.03,
    })]);
    const cache = await readFile(cachePath, "utf8");
    expect(cache).not.toContain("private parent content");
    expect(cache).not.toContain("private child content");
  });

  it("discards a v3 cache so UTC-bucketed rows cannot survive the upgrade", async () => {
    // v3 stored a precomputed UTC `day`. v4 buckets in host-local time, so a
    // reused v3 entry would mix the two silently and forever.
    const directory = await temporaryDirectory();
    const root = join(directory, "sessions");
    const cachePath = join(directory, "cache", "codex.json");
    await mkdir(root, { recursive: true });
    await mkdir(join(directory, "cache"), { recursive: true });
    await writeFile(join(root, "rollout-test.jsonl"), [
      { timestamp: "2026-08-09T12:00:00Z", type: "session_meta", payload: { id: "session-1" } },
      { timestamp: "2026-08-09T12:00:00Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      { timestamp: "2026-08-09T12:00:01Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 5, output_tokens: 20 } } } },
    ].map((value) => JSON.stringify(value)).join("\n"));

    await writeFile(cachePath, JSON.stringify({
      version: 3,
      agentId: "codex",
      files: { stale: { signature: "stale", rows: [{ day: "1999-01-01", modelProviderId: "openai", model: "poisoned", uncachedInputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, loggedCostUsd: null }] } },
    }));

    const result = await scan("codex", root, cachePath);
    expect(result.reusedFileCount).toBe(0);
    expect(result.rows.map((row) => row.day)).not.toContain("1999-01-01");
    expect(JSON.parse(await readFile(cachePath, "utf8")).version).toBe(5);
  });

  it("keeps host filesystem paths out of failure diagnostics", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, "sessions");
    const cachePath = join(directory, "cache", "codex.json");
    await mkdir(root, { recursive: true });
    // Discoverable and stat-able, but unreadable -- so parseFile throws and the
    // failure path runs with a real filePath in scope.
    const secret = join(root, "rollout-secret.jsonl");
    await writeFile(secret, "{}\n");
    await chmod(secret, 0o000);

    const result = await scan("codex", root, cachePath);
    expect(result.failureCount).toBeGreaterThan(0);
    // `error` carries the first failure string off the host verbatim.
    expect(result.error).toBe("A usage log could not be read.");
    await chmod(secret, 0o600);
  });
});


it.each(["pi", "prime"] as const)("keeps mixed %s cost buckets across scans", async (agentId) => {
  const directory = await temporaryDirectory();
  const root = join(directory, "sessions");
  await mkdir(root);
  const cachePath = join(directory, "cache.json");
  await writeFile(join(root, "session.jsonl"), [7, 0].map((cost, id) => JSON.stringify({
    type: "message", id: String(id), timestamp: "2026-08-09T00:00:01Z", message: {
      role: "assistant", provider: "openai", model: "gpt-5.6-sol",
      usage: { input: 1000000, output: 0, cost: { total: cost } },
    },
  })).join("\n"));
  const { parseHostUsageAggregates } = await import("../collectors");
  for (let i = 0; i < 2; i++) {
    const result = await scan(agentId, root, cachePath);
    const rows = parseHostUsageAggregates(JSON.stringify(result.rows), agentId, { machineId: "test", machineName: "test" });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(r => r.eventKey)).size).toBe(2);
    expect(rows.reduce((sum, row) => sum + row.costUsd, 0)).toBe(12);
    expect(rows.reduce((sum, row) => sum + row.processedTokens, 0)).toBe(2000000);
    expect(result.reusedFileCount).toBe(i);
  }
});
