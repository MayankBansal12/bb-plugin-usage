import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const hostCommandContract = defineRpcContract({
  run: {
    input: z.object({
      command: z.string().min(1),
      timeoutMs: z.number().int().min(1).max(10 * 60_000),
    }).strict(),
    output: z.object({
      stdout: z.string(),
      stderr: z.string(),
      exitCode: z.number().int(),
    }).strict(),
  },
});
