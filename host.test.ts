import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@get-bb/plugin-sdk", () => ({
  defineRpcContract: <T>(contract: T) => contract,
  experimental_defineHostEntry: <T>(entry: T) => entry,
}));

import { executeShellCommand } from "./host";

describe("host command worker", () => {
  it("captures stdout without a terminal session", async () => {
    await expect(executeShellCommand(
      "printf 'hello'",
      1_000,
      new AbortController().signal,
    )).resolves.toEqual({ stdout: "hello", stderr: "", exitCode: 0 });
  });

  it("returns stderr and the real non-zero exit code", async () => {
    await expect(executeShellCommand(
      "printf 'bad input' >&2; exit 7",
      1_000,
      new AbortController().signal,
    )).resolves.toEqual({ stdout: "", stderr: "bad input", exitCode: 7 });
  });

  it("kills a command that exceeds its timeout", async () => {
    await expect(executeShellCommand(
      "sleep 1",
      20,
      new AbortController().signal,
    )).rejects.toThrow("timed out");
  });

  it("kills a command when the host call is cancelled", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("cancelled by test")), 20);

    await expect(executeShellCommand(
      "sleep 1",
      1_000,
      controller.signal,
    )).rejects.toThrow("cancelled by test");
  });
});

function shellQuote(value: string) {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    // An orphan may briefly remain a zombie on Linux until init reaps it.
    if (process.platform === "linux") {
      return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
    }
    return true;
  } catch { return false; }
}

describe("process tree cleanup", () => {
  it.each(["timeout", "abort", "overflow"] as const)("stops a SIGTERM-resistant descendant on %s", async (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "usage-process-test-"));
    const pidFile = join(directory, "pid");
    const controller = new AbortController();
    let pid: number | undefined;
    const script = `
      process.on("SIGTERM", () => {});
      require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      if (${JSON.stringify(mode)} === "overflow") process.stdout.write("x".repeat(900001));
      setInterval(() => {}, 1000);
    `;
    // Keep a shell parent instead of allowing shell exec optimization.
    const command = `${shellQuote(process.execPath)} -e ${shellQuote(script)} & wait`;
    const result = executeShellCommand(command, mode === "timeout" ? 500 : 3000, controller.signal);
    const rejected = expect(result).rejects.toThrow(mode === "timeout" ? "timed out" : mode === "overflow" ? "output limit" : "cancelled");
    try {
      await vi.waitFor(() => { pid = Number(readFileSync(pidFile, "utf8")); expect(pid).toBeGreaterThan(0); });
      if (mode === "abort") controller.abort(new Error("cancelled"));
      await rejected;
      await vi.waitFor(() => expect(isRunning(pid!)).toBe(false));
    } finally {
      controller.abort();
      await result.catch(() => {});
      if (pid && isRunning(pid)) process.kill(pid, "SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not start an already-cancelled command", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    await expect(executeShellCommand("exit 0", 1000, controller.signal)).rejects.toThrow("already cancelled");
  });
});
