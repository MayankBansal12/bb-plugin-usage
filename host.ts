import { exec, type ExecException } from "node:child_process";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { hostCommandContract } from "./host-contract";

const MAX_COMMAND_OUTPUT_BYTES = 900_000;

function exitCode(error: ExecException | null) {
  if (!error) return 0;
  return typeof error.code === "number" ? error.code : 1;
}

export function executeShellCommand(
  command: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    exec(command, {
      timeout: timeoutMs,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      signal,
    }, (error, stdout, stderr) => {
      if (signal.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error("Command was cancelled."));
        return;
      }
      if (error?.message.includes("maxBuffer")) {
        reject(new Error(`Command exceeded the ${Math.floor(MAX_COMMAND_OUTPUT_BYTES / 1000)} KB output limit.`));
        return;
      }
      if (error?.killed) {
        reject(new Error(`Command timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`));
        return;
      }
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_COMMAND_OUTPUT_BYTES) {
        reject(new Error(`Command exceeded the ${Math.floor(MAX_COMMAND_OUTPUT_BYTES / 1000)} KB output limit.`));
        return;
      }
      resolve({ stdout, stderr, exitCode: exitCode(error) });
    });
  });
}

export default experimental_defineHostEntry({
  contract: hostCommandContract,
  handlers: {
    run: ({ command, timeoutMs }, context) => executeShellCommand(command, timeoutMs, context.signal),
  },
});
