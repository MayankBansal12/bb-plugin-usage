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
