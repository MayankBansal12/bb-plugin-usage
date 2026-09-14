import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
function run(input: unknown, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, [resolve("scripts/cursor-usage-hook.mjs"), ...args]);
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("close", (code) => done({ code, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}
it("records only real Cursor counters and strips content and identifying paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bb-cursor-hook-")); directories.push(dir);
  const output = join(dir, "custom", "usage.jsonl");
  const event = { hook_event_name: "afterAgentResponse", conversation_id: "session-secret", generation_id: "response-secret",
    text: "private reply", workspace_roots: ["/private/path/project"], model: "some-model",
    input_tokens: 20, output_tokens: 5, cache_read_tokens: 60, cache_write_tokens: 10 };
  const result = await run(event, ["--output", output]);
  expect(result).toEqual({ code: 0, stdout: "{}\n", stderr: "" });
  const content = await readFile(output, "utf8");
  expect(content).not.toMatch(/private|secret|workspace_roots|text/);
  expect(JSON.parse(content)).toMatchObject({ version: 1, kind: "cursor-response", project: "project", input_tokens: 20,
    output_tokens: 5, cache_read_tokens: 60, cache_write_tokens: 10, eventId: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect((await stat(output)).mode & 0o777).toBe(0o600);
  await run(event, ["--output", output]);
  const lines = (await readFile(output, "utf8")).trim().split("\n").map((s) => JSON.parse(s));
  expect(lines[0].eventId).toBe(lines[1].eventId);
});
it.each([
  { used: 123, size: 200000 }, { input_tokens: -1, output_tokens: 1 }, { input_tokens: "123", output_tokens: 1 },
  { input_tokens: 0, output_tokens: 0 }, { input_tokens: 1, output_tokens: 2, cache_read_tokens: -1 },
  { input_tokens: 1, output_tokens: 2, hook_event_name: "afterAgentThought" },
])("does not invent usage from incomplete, context-only, or invalid hook data: %j", async (fields) => {
  const dir = await mkdtemp(join(tmpdir(), "bb-cursor-hook-")); directories.push(dir);
  const output = join(dir, "usage.jsonl");
  expect((await run({ conversation_id: "s", generation_id: "r", ...fields }, ["--output", output])).code).toBe(0);
  await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
});
it("provides help and rejects ambiguous paths without reading hook input", async () => {
  expect((await run("", ["--help"])).stdout).toContain("afterAgentResponse");
  expect((await run("", ["--output", "relative.jsonl"])).code).toBe(1);
  const invalid = await run("not json", []);
  expect(invalid).toMatchObject({ code: 0, stdout: "{}\n" });
  expect(invalid.stderr).not.toContain("not json");
});
