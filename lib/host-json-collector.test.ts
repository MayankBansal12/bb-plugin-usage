import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  compressedHostJsonCollectorScript,
  extractHostJsonScan,
  type HostJsonAgentId,
} from "./host-json-collector";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "bb-usage-host-scan-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function scan(agentId: HostJsonAgentId, root: string, cachePath: string) {
  const script = compressedHostJsonCollectorScript({
    agentId,
    roots: [root],
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
      { timestamp: "2026-08-09T00:00:00Z", type: "session_meta", payload: { id: "session-1", prompt: "must not be cached" } },
      { timestamp: "2026-08-09T00:00:00Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
      { timestamp: "2026-08-09T00:00:01Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 5, output_tokens: 20 } } } },
    ].map((value) => JSON.stringify(value)).join("\n"));

    const first = await scan("codex", root, cachePath);
    expect(first).toMatchObject({ fileCount: 1, changedFileCount: 1, reusedFileCount: 0, failureCount: 0 });
    expect(first.rows).toEqual([expect.objectContaining({
      day: "2026-08-09",
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
      day: "2026-08-09",
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
});
