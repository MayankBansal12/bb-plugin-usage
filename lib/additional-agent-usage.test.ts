import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { parseHostUsageAggregates } from "../collectors";
import { compressedHostJsonCollectorScript, extractHostJsonScan } from "./host-json-collector";

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "bb-additional-usage-"));
  directories.push(root);
  return root;
}
async function scan(agentId: "codebuddy" | "cursor", root: string, env?: NodeJS.ProcessEnv) {
  const { stdout } = await exec(process.execPath, ["-e", compressedHostJsonCollectorScript({
    agentId, roots: [root], cachePath: join(root, "cache.json"), sinceDay: "2026-08-01",
  })], { env: { ...process.env, CODEBUDDY_CONFIG_DIR: "", ...env } });
  return extractHostJsonScan(stdout);
}

it("collects CodeBuddy calls once across copied transcripts and cached rescans", async () => {
  const root = await setup();
  const record = {
    id: "item-1", type: "function_call", timestamp: "2026-08-10T12:00:00Z", cwd: "/private/work/project",
    providerData: { messageId: "response-1", model: "gpt-5.6-sol", reasoning: "private reasoning" },
    message: { usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 60, cache_creation_input_tokens: 10 } },
    arguments: "private tool arguments",
  };
  await writeFile(join(root, "session.jsonl"), [record, record,
    { type: "turn-metrics", timestamp: record.timestamp, tokenDelta: 120 },
    { ...record, type: "function_call_result", id: "result" },
    { ...record, id: "item-2", providerData: { messageId: "response-2", model: "gpt-5.6-sol" } },
  ].map((v) => JSON.stringify(v)).join("\n"));
  await writeFile(join(root, "copy.jsonl"), JSON.stringify(record));
  const first = await scan("codebuddy", root);
  expect(first.failureCount).toBe(0);
  expect(first.rows).toEqual([expect.objectContaining({
    modelProviderId: "codebuddy", model: "gpt-5.6-sol", project: "project",
    uncachedInputTokens: 60, cachedInputTokens: 120, cacheWriteTokens: 20, outputTokens: 40,
  })]);
  const second = await scan("codebuddy", root);
  expect(second.reusedFileCount).toBe(2);
  expect(second.rows).toEqual(first.rows);
  expect(await readFile(join(root, "cache.json"), "utf8")).not.toMatch(/private|response-1|item-1/);
  const records = parseHostUsageAggregates(JSON.stringify(first.rows), "codebuddy", { machineId: "m", machineName: "M" });
  expect(records[0]).toMatchObject({ agentId: "codebuddy", agentName: "CodeBuddy", processedTokens: 240 });
});

it("keeps unknown CodeBuddy models as token-only usage and ignores incomplete and user rows", async () => {
  const root = await setup();
  const record = { id: "r", type: "message", role: "assistant", timestamp: 1786363200000,
    providerData: { model: "private-model" }, message: { usage: { input_tokens: 20, output_tokens: 5 } } };
  await writeFile(join(root, "session.jsonl"), [record, { ...record, role: "user", id: "u" },
    { ...record, id: "no-usage", message: {} }, { ...record, id: "zero", message: { usage: { input_tokens: 0, output_tokens: 0 } } },
  ].map((v) => JSON.stringify(v)).join("\n") + '\n{"incomplete":');
  const result = await scan("codebuddy", root);
  const rows = parseHostUsageAggregates(JSON.stringify(result.rows), "codebuddy", { machineId: "m", machineName: "M" });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ processedTokens: 25, pricingStatus: "unknown", costUsd: 0 });
});

it("honors host-side CodeBuddy config homes and recovers explicit raw cache writes", async () => {
  const root = await setup();
  const { mkdir } = await import("node:fs/promises");
  const projects = join(root, "custom", "projects");
  await mkdir(projects, { recursive: true });
  await writeFile(join(projects, "session.jsonl"), JSON.stringify({
    id: "request", type: "assistant", timestamp: "2026-08-10T12:00:00Z",
    providerData: { model: "claude-test", rawUsage: { cache_creation_input_tokens: 30, prompt_cache_miss_tokens: 40 } },
    message: { usage: { input_tokens: 100, cache_read_input_tokens: 60, output_tokens: 5 } },
  }));
  const result = await scan("codebuddy", join(root, "unrelated"), { CODEBUDDY_CONFIG_DIR: join(root, "custom") });
  expect(result.rows).toEqual([expect.objectContaining({ uncachedInputTokens: 10, cachedInputTokens: 60, cacheWriteTokens: 30, outputTokens: 5 })]);
});

it("collects Cursor metadata ledgers without adding cache twice or inferring tokens from context", async () => {
  const root = await setup();
  const event = { version: 1, kind: "cursor-response", eventId: "hash", timestamp: "2026-08-10T12:00:00Z",
    model: "cursor-grok-4.6-high", project: "project", input_tokens: 20, cache_read_tokens: 60, cache_write_tokens: 10, output_tokens: 5 };
  await writeFile(join(root, "usage.jsonl"), [event, event,
    { version: 1, kind: "cursor-response", eventId: "context", timestamp: event.timestamp, used: 99000, size: 200000 },
  ].map((v) => JSON.stringify(v)).join("\n"));
  const result = await scan("cursor", root);
  expect(result.rows).toEqual([expect.objectContaining({ uncachedInputTokens: 20, cachedInputTokens: 60, cacheWriteTokens: 10, outputTokens: 5 })]);
  expect(parseHostUsageAggregates(JSON.stringify(result.rows), "cursor", { machineId: "m", machineName: "M" })[0])
    .toMatchObject({ agentId: "cursor", agentName: "Cursor Agent", processedTokens: 95 });
});
