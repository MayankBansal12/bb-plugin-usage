import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  compressedHostJsonCollectorScript,
  extractHostJsonScan,
  type HostJsonAgentId,
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

async function scan(agentId: HostJsonAgentId, root: string | string[], cachePath: string) {
  const script = compressedHostJsonCollectorScript({
    agentId,
    roots: Array.isArray(root) ? root : [root],
    cachePath,
    sinceDay: "2026-08-01",
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

  it("decodes concatenated dsh session frames and aggregates settlement usage", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, "sessions");
    const sessionDir = join(root, "--home-user-code-dsh-proj--", "session-uuid");
    const cachePath = join(directory, "cache", "dsh.json");
    await mkdir(sessionDir, { recursive: true });
    // dsh seals one zstd frame per append batch, so a session file is a
    // concatenation that Node's decoder only partially reads.
    const frame = (records: unknown[]) => zstdCompressSync(
      Buffer.from(`${records.map((value) => JSON.stringify(value)).join("\n")}\n`),
    );
    await writeFile(join(sessionDir, "session.v3.jsonl.zstd"), Buffer.concat([
      frame([
        { type: "session", version: 3, id: "session-uuid", createdAt: Date.parse("2026-08-09T00:00:00Z"), cwd: "/home/user/code/dsh-proj", isSeeded: false, delegationDepth: 0 },
        { type: "request/context", seq: 1, time: Date.parse("2026-08-09T00:00:01Z"), data: { provider: "deepseek", model: "deepseek-v4.1-flash", contextWindow: 400000 } },
      ]),
      frame([
        { type: "assistant/message", seq: 2, time: Date.parse("2026-08-09T00:00:02Z"), data: {
          turn: 1, step: 1,
          message: { id: "m-private", role: "assistant", content: [{ type: "text", text: "private" }], source: {
            kind: "model", provider: "cliproxy", model: "deepseek-v4.1-flash-expires-on-0910",
            replayState: { response: { provider: "cliproxy", model: "deepseek-v4.1-flash-expires-on-0910", responseModel: "deepseek-flash" } },
          } },
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 180, cacheReadTokens: 60 },
        } },
        { type: "assistant/attempt", seq: 3, time: Date.parse("2026-08-09T00:01:00Z"), data: {
          turn: 2, step: 1,
          stream: [
            { type: "chunk", time: Date.parse("2026-08-09T00:00:59Z"), chunk: { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } },
            { type: "chunk", time: Date.parse("2026-08-09T00:01:00Z"), chunk: { type: "finish", reason: { kind: "error", failure: { message: "private", code: "ABORTED" } } } },
          ],
        } },
        // A committed message whose usage only survives in its stream, and a
        // zero-usage settlement that must not produce a row.
        { type: "assistant/message", seq: 4, time: Date.parse("2026-08-09T00:02:00Z"), data: {
          turn: 3, step: 1,
          message: { id: "m2", role: "assistant", content: [], source: { kind: "model", provider: "cliproxy", model: "deepseek-v4-pro" } },
          stream: [{ type: "chunk", time: Date.parse("2026-08-09T00:02:00Z"), chunk: { type: "usage", usage: { inputTokens: 30, outputTokens: 7, totalTokens: 37 } } }],
        } },
        { type: "assistant/message", seq: 5, time: Date.parse("2026-08-09T00:03:00Z"), data: {
          turn: 4, step: 1,
          message: { id: "m3", role: "assistant", content: [], source: { kind: "model", provider: "cliproxy", model: "deepseek-v4-pro" } },
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        } },
      ]),
    ]));
    // A migration leaves older immutable generations next to the live v3 log;
    // they carry the same history and must not be counted a second time.
    await writeFile(join(sessionDir, "session.v2.jsonl.zstd"), frame([
      { type: "session", version: 2, id: "session-uuid", createdAt: Date.parse("2026-08-09T00:00:00Z"), cwd: "/home/user/code/dsh-proj", isSeeded: false, delegationDepth: 0 },
      { type: "assistant/message", seq: 2, time: Date.parse("2026-08-09T00:00:02Z"), data: {
        turn: 1, step: 1,
        message: { id: "m-old", role: "assistant", content: [], source: { kind: "model", provider: "cliproxy", model: "deepseek-flash" } },
        usage: { inputTokens: 999, outputTokens: 999, totalTokens: 1998 },
      } },
    ]));

    const day = localDay("2026-08-09T00:00:02Z");
    const first = await scan("dsh", root, cachePath);
    expect(first).toMatchObject({ fileCount: 1, changedFileCount: 1, reusedFileCount: 0, failureCount: 0 });
    expect(first.rows).toEqual([
      expect.objectContaining({ day, modelProviderId: "cliproxy", model: "deepseek-flash", project: "dsh-proj", uncachedInputTokens: 100, cachedInputTokens: 60, outputTokens: 20, loggedCostUsd: null }),
      expect.objectContaining({ day, modelProviderId: "cliproxy", model: "deepseek-v4-pro", project: "dsh-proj", uncachedInputTokens: 30, outputTokens: 7 }),
      expect.objectContaining({ day, modelProviderId: "deepseek", model: "deepseek-v4.1-flash", project: "dsh-proj", uncachedInputTokens: 10, outputTokens: 5 }),
    ]);

    const cache = await readFile(cachePath, "utf8");
    expect(cache).not.toContain("private");
    expect(cache).not.toContain("m-private");
    expect(cache).not.toContain(root);

    const second = await scan("dsh", root, cachePath);
    expect(second).toMatchObject({ fileCount: 1, changedFileCount: 0, reusedFileCount: 1, failureCount: 0 });
    expect(second.rows).toEqual(first.rows);
  });

  it("reads a torn dsh frame's intact prefix without failing the file", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, "sessions");
    const cachePath = join(directory, "cache", "dsh.json");
    await mkdir(root, { recursive: true });
    const message = (seq: number, inputTokens: number) => ({
      type: "assistant/message", seq, time: Date.parse("2026-08-09T00:00:00Z") + seq, data: {
        turn: seq, step: 1,
        message: { id: `m-${seq}`, role: "assistant", content: [{ type: "text", text: `private ${seq} `.repeat(40) }], source: { kind: "model", provider: "deepseek", model: "deepseek-v4-pro" } },
        usage: { inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 },
      },
    });
    const frame = (records: unknown[]) => zstdCompressSync(
      Buffer.from(`${records.map((value) => JSON.stringify(value)).join("\n")}\n`),
    );
    const complete = frame([
      { type: "session", version: 3, id: "s", createdAt: Date.parse("2026-08-09T00:00:00Z"), cwd: "/work/app", isSeeded: false, delegationDepth: 0 },
      message(1, 100),
    ]);
    const torn = frame(Array.from({ length: 300 }, (_, index) => message(index + 2, 10)));
    // An interrupted append leaves a structurally incomplete final frame.
    await writeFile(join(root, "session.v3.jsonl.zstd"), Buffer.concat([complete, torn.subarray(0, torn.length - 8)]));

    const result = await scan("dsh", root, cachePath);
    expect(result).toMatchObject({ fileCount: 1, failureCount: 0 });
    const row = result.rows.find((candidate) => candidate.day === localDay("2026-08-09T00:00:00Z"));
    // The complete frame contributes 100 input tokens; the torn frame's
    // recoverable prefix adds more of its 300 ten-token messages.
    expect(row?.uncachedInputTokens).toBeGreaterThan(100);
  });

  it("counts only a seeded dsh session's own events after the last end-seed boundary", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, "sessions");
    const cachePath = join(directory, "cache", "dsh.json");
    await mkdir(root, { recursive: true });
    const frame = (records: unknown[]) => zstdCompressSync(
      Buffer.from(`${records.map((value) => JSON.stringify(value)).join("\n")}\n`),
    );
    const message = (seq: number, inputTokens: number) => ({
      type: "assistant/message", seq, time: Date.parse("2026-08-09T00:00:00Z") + seq, data: {
        turn: seq, step: 1,
        message: { id: `m-${seq}`, role: "assistant", content: [], source: { kind: "model", provider: "deepseek", model: "deepseek-v4-pro" } },
        usage: { inputTokens, outputTokens: 1, totalTokens: inputTokens + 1 },
      },
    });
    // A forked session's stored log is the parent's prefix (which itself may
    // carry an end-seed marker) followed by this session's own end-seed and
    // events; only events after the LAST marker are this session's usage.
    await writeFile(join(root, "session.v3.jsonl.zstd"), frame([
      { type: "session", version: 3, id: "child", createdAt: Date.parse("2026-08-09T00:00:00Z"), cwd: "/work/forked-proj", isSeeded: true, delegationDepth: 0 },
      { type: "request/context", seq: 1, time: Date.parse("2026-08-09T00:00:00Z"), data: { provider: "deepseek", model: "deepseek-v4-pro" } },
      message(2, 500),
      { type: "session/end-seed", seq: 3, time: Date.parse("2026-08-09T00:00:00Z"), data: { inherited: true } },
      message(4, 400),
      { type: "session/end-seed", seq: 5, time: Date.parse("2026-08-09T00:00:00Z"), data: { inherited: true } },
      message(6, 100),
      // An untagged end-seed is an ordinary resume boundary, not a new
      // inherited cut: usage after it still belongs to this session.
      { type: "session/end-seed", seq: 7, time: Date.parse("2026-08-09T00:00:00Z"), data: {} },
      message(8, 50),
    ]));

    const result = await scan("dsh", root, cachePath);
    expect(result).toMatchObject({ fileCount: 1, failureCount: 0 });
    expect(result.rows).toEqual([
      expect.objectContaining({ project: "forked-proj", uncachedInputTokens: 150, outputTokens: 2 }),
    ]);
  });

  it("fails a non-Zstandard dsh log without leaking host details", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, "sessions");
    const cachePath = join(directory, "cache", "dsh.json");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "session.v3.jsonl.zstd"), "not a zstd frame");

    const result = await scan("dsh", root, cachePath);
    expect(result).toMatchObject({ fileCount: 1, failureCount: 1 });
    expect(result.error).toBe("A usage log could not be read.");
    expect(result.rows).toEqual([]);
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
