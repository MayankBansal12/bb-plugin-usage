#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const help = `Usage: node scripts/cursor-usage-hook.mjs [--output FILE]

Record token metadata from Cursor CLI's afterAgentResponse hook on stdin.
Requires a CLI version that supplies input_tokens/output_tokens in this hook.
Input tokens are uncached; cache counters are separate. Missing counters are
not estimated. Prompts, response text, and full workspace paths are discarded.

Options:
  --output FILE  Absolute or ~/ JSONL ledger path (default: ~/.cursor/usage.jsonl)
  -h, --help     Show this help without reading stdin

Outputs:
  Appends one metadata-only line (file mode 0600); stdout is {}.
  Invalid/missing hook data and recording failures never block the agent.
  Invalid command options exit 1. Hook input is limited to 8 MiB and 2 seconds.

Examples:
  node scripts/cursor-usage-hook.mjs < after-response.json
  node scripts/cursor-usage-hook.mjs --output /data/cursor/usage.jsonl < after-response.json
`;

function parseArgs(args) {
  if (args.length === 1 && ["-h", "--help"].includes(args[0])) return { help: true };
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--output")) throw new Error("Use --help for valid options.");
  const raw = args[1] ?? join(homedir(), ".cursor", "usage.jsonl");
  const output = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  if (!isAbsolute(output)) throw new Error("--output must be an absolute or ~/ path.");
  return { output };
}

async function readInput() {
  const chunks = [];
  let bytes = 0;
  const timer = setTimeout(() => process.stdin.destroy(new Error("Hook input timeout.")), 2000);
  try {
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) throw new Error("Hook input exceeds 8 MiB.");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    clearTimeout(timer);
    process.stdin.destroy();
  }
}

function record(value) {
  if (!value || typeof value !== "object") return null;
  if (value.hook_event_name !== undefined && value.hook_event_name !== "afterAgentResponse") return null;
  const validCount = (v) => Number.isSafeInteger(v) && v >= 0;
  if (!validCount(value.input_tokens) || !validCount(value.output_tokens)) return null;
  if ([value.cache_read_tokens, value.cache_write_tokens].some((v) => v !== undefined && !validCount(v))) return null;
  if (typeof value.conversation_id !== "string" || !value.conversation_id || typeof value.generation_id !== "string" || !value.generation_id) return null;
  const total = value.input_tokens + value.output_tokens + (value.cache_read_tokens ?? 0) + (value.cache_write_tokens ?? 0);
  if (total === 0 || !Number.isSafeInteger(total)) return null;
  const workspace = typeof value.cwd === "string" ? value.cwd : Array.isArray(value.workspace_roots) ? value.workspace_roots[0] : "";
  const project = typeof workspace === "string" ? workspace.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() : "";
  return {
    version: 1, kind: "cursor-response",
    eventId: createHash("sha256").update(JSON.stringify([value.conversation_id, value.generation_id])).digest("hex"),
    timestamp: new Date().toISOString(),
    model: typeof value.model === "string" ? value.model.slice(0, 200) : "unknown",
    project: project?.trim().slice(0, 80) || "Unknown",
    input_tokens: value.input_tokens, output_tokens: value.output_tokens,
    cache_read_tokens: value.cache_read_tokens ?? 0, cache_write_tokens: value.cache_write_tokens ?? 0,
  };
}

let options;
try { options = parseArgs(process.argv.slice(2)); }
catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
if (options?.help) process.stdout.write(help);
else if (options) {
  try {
    const event = record(await readInput());
    if (event) {
      await mkdir(dirname(options.output), { recursive: true, mode: 0o700 });
      await appendFile(options.output, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    }
  } catch {
    // A metrics failure must not change Cursor's permission or turn outcome.
    process.stderr.write("BB Usage: could not record Cursor token metadata.\n");
  }
  process.stdout.write("{}\n");
}
