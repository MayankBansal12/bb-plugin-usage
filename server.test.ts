import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@bb/plugin-sdk";

vi.mock("@bb/plugin-sdk", () => ({
  defineRpcContract: <T>(contract: T) => contract,
}));

import plugin from "./server";

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
