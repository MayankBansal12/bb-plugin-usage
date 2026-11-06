import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runShellCommand } from "./host-shell";

const tempDirs: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "usage-host-shell-"));
  tempDirs.push(dir);
  return dir;
}

function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("host shell runner", () => {
  it("returns stdout, stderr, and the exit code, then removes its script", async () => {
    const dir = tempDir();
    await expect(runShellCommand("printf 'out\\n'; printf 'err\\n' >&2; exit 3", {
      tempDir: dir,
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: "exited", exitCode: 3, output: "out\nerr\n" });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("runs scripts far larger than a command-line argument", async () => {
    const padding = "x".repeat(2_000_000);
    await expect(runShellCommand(`: '${padding}'; printf done`, {
      tempDir: tempDir(),
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: "exited", exitCode: 0, output: "done" });
  });

  it("stops a command that exceeds the output limit", async () => {
    await expect(runShellCommand("while :; do printf '%01000d\\n' 0; done", {
      tempDir: tempDir(),
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: "output-limit" });
  });

  it("kills the whole process tree when the call is cancelled", async () => {
    const dir = tempDir();
    const pidFile = join(dir, "child.pid");
    const controller = new AbortController();
    const run = runShellCommand(`sleep 30 & printf '%s' "$!" > '${pidFile}'; wait`, {
      tempDir: dir,
      signal: controller.signal,
    });
    let pid = 0;
    while (!pid) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      pid = Number(readFileSync(pidFile, { encoding: "utf8", flag: "a+" }) || 0);
    }
    controller.abort(new Error("sync cancelled"));
    await expect(run).rejects.toThrow("sync cancelled");
    await expect.poll(() => isRunning(pid)).toBe(false);
  });
});
