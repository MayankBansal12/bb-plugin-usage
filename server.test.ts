import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@bb/plugin-sdk";

vi.mock("@bb/plugin-sdk", () => ({
  defineRpcContract: <T>(contract: T) => contract,
}));

import plugin, { loadProviderLimits, runHostCommand } from "./server";

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

describe("host command output", () => {
  it("collects output while the terminal is still running, then closes it", async () => {
    const text = "query result\n__BB_HOST_COMMAND_DONE__:0\n";
    const create = vi.fn(async (input: unknown) => ({ id: "terminal-1", status: "starting", input }));
    const get = vi.fn(async () => ({ id: "terminal-1", status: "running" }));
    const output = vi.fn(async () => ({
      chunks: [{ seq: 1, dataBase64: Buffer.from(text).toString("base64") }],
      truncated: false,
    }));
    const close = vi.fn(async () => undefined);
    const bb = { sdk: { terminals: { create, get, output, close } } } as unknown as BbPluginApi;

    await expect(runHostCommand(
      bb,
      { id: "host-1", name: "Machine" },
      "printf result",
      new AbortController().signal,
      { title: "Usage test", timeoutMs: 1_000, pollMs: 1 },
    )).resolves.toBe(text);

    expect(get).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith({ terminalId: "terminal-1", mode: "force" });
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      start: { mode: "command", command: expect.stringContaining("__BB_HOST_COMMAND_DONE__") },
    });
  });

  it("surfaces a command diagnostic before closing the held terminal", async () => {
    const text = "__BB_USAGE_ERROR__:sqlite3 is missing\n__BB_HOST_COMMAND_DONE__:127\n";
    const close = vi.fn(async () => undefined);
    const bb = {
      sdk: { terminals: {
        create: vi.fn(async () => ({ id: "terminal-1", status: "starting" })),
        get: vi.fn(async () => ({ id: "terminal-1", status: "running" })),
        output: vi.fn(async () => ({ chunks: [{ seq: 1, dataBase64: Buffer.from(text).toString("base64") }], truncated: false })),
        close,
      } },
    } as unknown as BbPluginApi;

    await expect(runHostCommand(
      bb,
      { id: "host-1", name: "Machine" },
      "exit 127",
      new AbortController().signal,
      { title: "Usage test", timeoutMs: 1_000, pollMs: 1 },
    )).rejects.toThrow("sqlite3 is missing");
    expect(close).toHaveBeenCalledOnce();
  });
});
