import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const HOST_COMMAND_OUTPUT_MAX_BYTES = 900_000;

// The server calls this on each enrolled machine's bb host worker (host.ts).
// `run` executes one POSIX shell collector and returns its combined
// stdout/stderr, so collection opens no terminals.
export const usageHostContract = defineRpcContract({
  run: {
    input: z.object({ command: z.string().min(1) }),
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("exited"), exitCode: z.number().int(), output: z.string() }),
      z.object({ status: z.literal("output-limit") }),
    ]),
  },
});
