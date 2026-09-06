import { randomUUID } from "node:crypto";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { describe, expect, it } from "vitest";
import { createCommandHostEntry } from "./host";
import { runHostCommand } from "./server";

describe("host worker RPC integration", () => {
  it("completes a scan beyond 30 seconds using short validated calls", async () => {
    const harness = experimental_createHostEntryHarness(createCommandHostEntry());
    let polls = 0;
    let longestCall = 0;
    const client = {
      call: async (method: "run" | "cancel", input: never, options: { signal: AbortSignal }) => {
        const start = performance.now();
        const result = await harness.experimental_call(method, input, options);
        longestCall = Math.max(longestCall, performance.now() - start);
        if (method === "run") polls++;
        return result;
      },
    } as unknown as Parameters<typeof runHostCommand>[0];
    try {
      await expect(runHostCommand(client, { id: "test-host", name: "Test" }, "sleep 31; printf complete",
        new AbortController().signal, { title: "Long scan", timeoutMs: 40_000 })).resolves.toBe("complete");
      expect(polls).toBeGreaterThan(1);
      expect(longestCall).toBeLessThan(5_000);
      expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(0);
    } finally { await harness.experimental_dispose(); }
  }, 45_000);

  it("retains a running job, cancels it, and frees its slot", async () => {
    const harness = experimental_createHostEntryHarness(createCommandHostEntry());
    const id = randomUUID();
    try {
      await expect(harness.experimental_call("run", { id, command: "sleep 20", timeoutMs: 30_000 })).resolves.toEqual({ state: "running" });
      expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(1);
      await harness.experimental_call("cancel", { id });
      expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(0);
      await expect(harness.experimental_call("run", { id: randomUUID(), command: "printf next", timeoutMs: 1000 }))
        .resolves.toEqual({ state: "done", result: { stdout: "next", stderr: "", exitCode: 0 } });
    } finally { await harness.experimental_dispose(); }
  });

  it("cleans up retained work when the worker is disposed", async () => {
    const harness = experimental_createHostEntryHarness(createCommandHostEntry());
    await harness.experimental_call("run", { id: randomUUID(), command: "sleep 20", timeoutMs: 30_000 });
    await harness.experimental_dispose();
    expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(0);
  });
});
