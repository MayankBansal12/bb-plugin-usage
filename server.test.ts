import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@bb/plugin-sdk";

vi.mock("@bb/plugin-sdk", () => ({
  defineRpcContract: <T>(contract: T) => contract,
}));

import plugin, { loadProviderLimits } from "./server";

describe("sync RPC", () => {
  it("returns before a slow collection completes", async () => {
    let handlers: { sync: () => unknown } | undefined;
    const collection = new Promise<never>(() => {});
    const db = { prepare: vi.fn(() => ({ get: vi.fn() })) };
    const bb = {
      settings: { define: vi.fn() },
      storage: { database: vi.fn(() => db), migrate: vi.fn() },
      rpc: {
        register: vi.fn((_contract: unknown, registered: unknown) => {
          handlers = registered as { sync: () => unknown };
        }),
      },
      sdk: { hosts: { list: vi.fn(() => collection) } },
      realtime: { publish: vi.fn() },
      background: { service: vi.fn() },
      log: { error: vi.fn() },
    } as unknown as BbPluginApi;

    await plugin(bb);

    expect(handlers?.sync()).toEqual({ ok: true });
    expect(bb.sdk.hosts.list).toHaveBeenCalledOnce();
  });
});

describe("provider limit loading", () => {
  it("does not block the dashboard when a connected machine stalls", async () => {
    const usageLimits = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const debug = vi.fn();
    const bb = {
      sdk: { system: { usageLimits } },
      log: { debug },
    } as unknown as BbPluginApi;

    await expect(loadProviderLimits(bb, [
      { id: "host_1", name: "Slow machine", status: "connected" },
    ], 10)).resolves.toEqual([]);
    expect(usageLimits).toHaveBeenCalledWith({ hostId: "host_1", signal: expect.any(AbortSignal) });
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("Provider limits unavailable"));
  });

  it("keeps limits returned by responsive machines", async () => {
    const usageLimits = vi.fn(async (_args: { hostId: string; signal: AbortSignal }) => ({
      codex: {
        status: "ok",
        planLabel: "Pro",
        windows: [{ label: "5 hours", usedPercent: 42, resetsAt: null }],
      },
      claudeCode: { status: "unavailable", planLabel: null, windows: [] },
      cursor: { status: "unavailable", planLabel: null, windows: [] },
    }));
    const bb = {
      sdk: { system: { usageLimits } },
      log: { debug: vi.fn() },
    } as unknown as BbPluginApi;

    await expect(loadProviderLimits(bb, [
      { id: "host_1", name: "Fast machine", status: "connected" },
    ], 1_000)).resolves.toEqual([expect.objectContaining({
      machineId: "host_1",
      providerId: "codex",
      planLabel: "Pro",
    })]);
  });
});
