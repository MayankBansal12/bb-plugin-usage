import { spawn } from "node:child_process";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { hostCommandContract } from "./host-contract";

const MAX_COMMAND_OUTPUT_BYTES = 900_000;
const TERMINATION_GRACE_MS = 250;

export function executeShellCommand(
  command: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Command was cancelled."));
  return new Promise((resolve, reject) => {
    // A separate POSIX process group lets cancellation reach the shell's children.
    // Collectors already require a POSIX shell on macOS/Linux.
    const child = spawn("/bin/sh", ["-c", command], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let closed = false;
    let code = 1;
    let terminating = false;

    const killGroup = (terminationSignal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, terminationSignal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          failure = new Error(`Could not terminate command processes: ${String(error)}`);
        }
      }
    };
    const finish = () => {
      if (!closed || terminating) return;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (failure) reject(failure);
      else resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode: code });
    };
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      terminating = true;
      killGroup("SIGTERM");
      // Keep escalation scheduled even if the shell exits first: a descendant
      // may ignore SIGTERM or have closed its inherited output descriptors.
      setTimeout(() => {
        killGroup("SIGKILL");
        terminating = false;
        finish();
      }, TERMINATION_GRACE_MS);
    };
    const onAbort = () => stop(signal.reason instanceof Error ? signal.reason : new Error("Command was cancelled."));
    const timer = setTimeout(() => stop(new Error(`Command timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`)), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > MAX_COMMAND_OUTPUT_BYTES) {
        stop(new Error(`Command exceeded the ${Math.floor(MAX_COMMAND_OUTPUT_BYTES / 1000)} KB output limit.`));
      } else chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => { failure ??= error; });
    child.on("close", (exitCode) => {
      closed = true;
      code = exitCode ?? 1;
      finish();
    });
  });
}

// A scan may exceed BB's 30-second RPC deadline. Keep it in the worker and
// return within one second; subsequent calls with the same id poll the result.
export function createCommandHostEntry() {
  type Result = Awaited<ReturnType<typeof executeShellCommand>>;
  type State = { state: "done"; result: Result } | { state: "error"; error: string };
  type Job = { controller: AbortController; done: Promise<State>; expiry: ReturnType<typeof setTimeout> };
  const jobs = new Map<string, Job>();
  const remove = async (id: string) => {
    const job = jobs.get(id);
    if (!job) return;
    job.controller.abort(new Error("Command was cancelled."));
    await job.done;
    clearTimeout(job.expiry);
    jobs.delete(id);
  };
  return experimental_defineHostEntry({
    contract: hostCommandContract,
    handlers: {
      run: async ({ id, command, timeoutMs }, context) => {
        let job = jobs.get(id);
        if (!job) {
          if (jobs.size >= 3) throw new Error("Too many usage scans on this host.");
          context.signal.throwIfAborted();
          const controller = new AbortController();
          const lease = context.experimental_retainWorker();
          const onDispose = () => controller.abort(new Error("Host worker was disposed."));
          context.lifecycle.signal.addEventListener("abort", onDispose, { once: true });
          if (context.lifecycle.signal.aborted) onDispose();
          const done = executeShellCommand(command, timeoutMs, controller.signal)
            .then((result): State => ({ state: "done", result }), (error): State => ({ state: "error", error: String(error.message ?? error) }))
            .finally(async () => {
              context.lifecycle.signal.removeEventListener("abort", onDispose);
              await lease.dispose();
            });
          const expiry = setTimeout(() => { void remove(id); }, timeoutMs + 60_000);
          expiry.unref();
          job = { controller, done, expiry };
          jobs.set(id, job);
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            job.done,
            new Promise<{ state: "running" }>((resolve) => {
              timer = setTimeout(() => resolve({ state: "running" }), 1000);
            }),
          ]);
        } finally { clearTimeout(timer); }
      },
      cancel: async ({ id }) => { await remove(id); return {}; },
    },
    dispose: async () => { await Promise.all([...jobs.keys()].map(remove)); },
  });
}

export default createCommandHostEntry();
