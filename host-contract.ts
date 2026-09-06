import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const commandResult = z.object({ stdout: z.string(), stderr: z.string(), exitCode: z.number().int() }).strict();
export const hostCommandContract = defineRpcContract({
  run: {
    input: z.object({
      id: z.string().uuid(),
      command: z.string().min(1),
      timeoutMs: z.number().int().min(1).max(10 * 60_000),
    }).strict(),
    output: z.discriminatedUnion("state", [
      z.object({ state: z.literal("running") }).strict(),
      z.object({ state: z.literal("done"), result: commandResult }).strict(),
      z.object({ state: z.literal("error"), error: z.string() }).strict(),
    ]),
  },
  cancel: {
    input: z.object({ id: z.string().uuid() }).strict(),
    output: z.object({}).strict(),
  },
});
