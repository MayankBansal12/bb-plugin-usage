import { z } from "zod";
import { codexResetCollectorSource } from "./host-scripts.generated";

export const resetCreditsSchema = z.object({
  availableCount: z.number().int().nonnegative().max(100_000),
  credits: z.array(z.object({ expiresAt: z.string().datetime().nullable().optional() })).max(1000).nullable(),
});

const snapshotSchema = z.object({
  accountEmail: z.string().min(1).max(320),
  planType: z.string().max(100),
  resetCredits: resetCreditsSchema,
});

export function parseCodexResetSnapshot(output: string) {
  const json = output.match(/__BB_CODEX_RESETS_BEGIN__\s*([^\r\n]+)\s*__BB_CODEX_RESETS_END__/)?.[1];
  if (!json) return null;
  try { return snapshotSchema.parse(JSON.parse(json)); } catch { return null; }
}

// Compiled before bundling. Only read requests are sent to the official CLI;
// neither credentials nor unfiltered protocol payloads leave the host.
export async function codexResetCollector() {
  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  const { createInterface } = require("node:readline") as typeof import("node:readline");
  const { homedir } = require("node:os") as typeof import("node:os");
  const child = spawn("codex", ["app-server"], { cwd: homedir(), stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  let nextId = 0;
  let received = 0;
  let failure: Error | null = null;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const stop = () => { child.kill("SIGKILL"); };
  const fail = () => {
    failure = new Error("Codex reset details unavailable.");
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
    stop();
  };
  const timer = setTimeout(fail, 10_000);
  child.on("error", fail);
  child.on("exit", fail);
  child.stdin.on("error", fail);
  child.stdout.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received > 262144) fail();
  });
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!message || typeof message !== "object") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error("Codex reset details unavailable."));
    else request.resolve(message.result);
  });
  const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  try {
    await request("initialize", { clientInfo: { name: "bb-usage", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    const { account } = await request("account/read", { refreshToken: false });
    if (account?.type !== "chatgpt" || typeof account.email !== "string" || typeof account.planType !== "string") return;
    const usage = await request("account/rateLimits/read", { excludeResetCreditDetails: false });
    const summary = usage?.rateLimitResetCredits;
    if (!summary || !Number.isSafeInteger(summary.availableCount) || summary.availableCount < 0) return;
    if (summary.credits != null && (!Array.isArray(summary.credits) || summary.credits.length > 1000)) return;
    // availableCount already counts only available credits, and the (possibly
    // capped) detail rows describe those credits. Rows in any other status are
    // outside the count, so they are skipped rather than subtracted again.
    let otherTypes = 0;
    const credits: Array<{ expiresAt?: string | null }> | null = summary.credits == null ? null : [];
    for (const credit of summary.credits ?? []) {
      if (!credit || typeof credit !== "object" || typeof credit.status !== "string"
        || typeof credit.resetType !== "string") return;
      if (credit.status !== "available") continue;
      if (credit.resetType !== "codexRateLimits") { otherTypes++; continue; }
      if (credit.expiresAt === null) credits!.push({ expiresAt: null });
      else if (credit.expiresAt === undefined) credits!.push({});
      else if (Number.isSafeInteger(credit.expiresAt) && credit.expiresAt > 0 && credit.expiresAt <= 8.64e12) {
        credits!.push({ expiresAt: new Date(credit.expiresAt * 1000).toISOString() });
      } else return;
    }
    // Available credits of an unrecognized type may or may not reset Codex
    // limits, so they never make a known count, and alone they leave it unknown.
    const availableCount = summary.availableCount - otherTypes;
    if (otherTypes > 0 && availableCount <= 0) return;
    // A capped detail list must not be mistaken for the account's full count.
    const resetCredits = { availableCount: Math.max(0, availableCount), credits };
    console.log("__BB_CODEX_RESETS_BEGIN__");
    console.log(JSON.stringify({ accountEmail: account.email, planType: account.planType, resetCredits }));
    console.log("__BB_CODEX_RESETS_END__");
  } catch {
    // Old CLIs, unavailable details, and signed-out accounts are unknown, not zero.
  } finally {
    clearTimeout(timer);
    lines.close();
    stop();
  }
}

export function codexResetsCommand() {
  const script = `${codexResetCollectorSource}\ncodexResetCollector().catch(() => {});`;
  return `set +x; node -e '${script.replace(/'/g, `'\\''`)}'`;
}
