import { experimental_execHostFile, experimental_spawnHostProcess } from "@get-bb/plugin-sdk/process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { constants, homedir } from "node:os";
import { join, win32 } from "node:path";
import { HOST_COMMAND_OUTPUT_MAX_BYTES } from "./host-contract";

export type HostShellResult =
  | { status: "exited"; exitCode: number; output: string }
  | { status: "output-limit" };

type HostShellOptions = { tempDir: string; signal: AbortSignal };

const WINDOWS_SHELL_MISSING = "__BB_USAGE_ERROR__:Git for Windows (sh.exe) is required to collect usage on Windows.";

let windowsShellLookup: Promise<string | null> | null = null;

// The collectors are POSIX sh. On Windows they run under Git for Windows' sh,
// found the same way bb finds it for lifecycle scripts.
async function gitForWindowsShell() {
  windowsShellLookup ??= experimental_execHostFile("git", ["var", "GIT_SHELL_PATH"], { timeout: 10_000, encoding: "utf8" })
    .then(({ stdout }) => stdout.trim() ? win32.normalize(stdout.trim()) : null, () => null)
    .then((shell) => {
      if (!shell) windowsShellLookup = null;
      return shell;
    });
  return windowsShellLookup;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function stopProcessTree(pid: number | undefined, windows: boolean) {
  if (pid === undefined) return;
  if (windows) {
    void experimental_execHostFile("taskkill", ["/pid", String(pid), "/T", "/F"], { encoding: "utf8" }).catch(() => undefined);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The process group has already exited.
  }
}

export async function runShellCommand(command: string, options: HostShellOptions): Promise<HostShellResult> {
  const windows = process.platform === "win32";
  let shell = "/bin/sh";
  let script = `${command}\n`;
  if (windows) {
    const windowsShell = await gitForWindowsShell();
    if (!windowsShell) return { status: "exited", exitCode: 127, output: `${WINDOWS_SHELL_MISSING}\n` };
    shell = windowsShell;
    // HOME in C:/ form keeps `$HOME/...` arguments valid for native node and
    // python, and /usr/bin supplies the coreutils the collectors call.
    const home = homedir().replace(/\\/g, "/").replace(/\/+$/, "");
    script = `HOME=${shellQuote(home)}; export HOME; PATH="/usr/bin:$PATH"; export PATH\n${script}`;
  }
  options.signal.throwIfAborted();
  // Scripts go through a file rather than `sh -c`: the serialized collectors
  // are large, and Windows argument quoting would have to survive MSYS parsing.
  const scriptPath = join(options.tempDir, `${randomUUID()}.sh`);
  await writeFile(scriptPath, script, { mode: 0o600 });
  try {
    // Cancellation may have arrived during the write, before we can listen.
    // Keep this check inside the try so the staged script is still removed.
    options.signal.throwIfAborted();
    return await new Promise<HostShellResult>((resolve, reject) => {
      const child = experimental_spawnHostProcess(shell, [windows ? scriptPath.replace(/\\/g, "/") : scriptPath], {
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
        detached: !windows,
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let byteLength = 0;
      let settled = false;
      const settle = (result: HostShellResult | Error) => {
        if (settled) return;
        settled = true;
        options.signal.removeEventListener("abort", abort);
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const abort = () => {
        stopProcessTree(child.pid, windows);
        settle(options.signal.reason instanceof Error ? options.signal.reason : new Error("Usage command was cancelled."));
      };
      options.signal.addEventListener("abort", abort, { once: true });
      const collect = (chunk: Buffer) => {
        if (settled) return;
        byteLength += chunk.length;
        if (byteLength > HOST_COMMAND_OUTPUT_MAX_BYTES) {
          stopProcessTree(child.pid, windows);
          settle({ status: "output-limit" });
          return;
        }
        chunks.push(chunk);
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.once("error", (error) => settle(error));
      child.once("exit", () => {
        // Helpers can keep the output pipes open after the shell exits, so
        // terminate them before waiting for close to drain the remaining data.
        if (!windows) stopProcessTree(child.pid, false);
      });
      child.once("close", (code, signal) => {
        settle({
          status: "exited",
          exitCode: code ?? 128 + (signal ? constants.signals[signal] : 0),
          output: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
  } finally {
    await rm(scriptPath, { force: true });
  }
}
