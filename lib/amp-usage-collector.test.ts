import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { compressedAmpUsageCollectorScript, extractAmpUsageScan } from "./amp-usage-collector";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "bb-usage-amp-scan-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function runScan(directory: string, cachePath: string, timezone?: string) {
  const script = compressedAmpUsageCollectorScript({ cachePath, deviceIdPath: join(directory, "device-id.json"), sinceDay: "2026-09-01" });
  const { stdout } = await execFileAsync(process.execPath, ["-e", script], {
    env: { ...process.env, PATH: `${join(directory, "bin")}:${process.env.PATH}`, ...(timezone ? { TZ: timezone } : {}) },
    maxBuffer: 2 * 1024 * 1024,
  });
  return extractAmpUsageScan(stdout.replace(/\n/g, "\r\n"));
}

async function fakeAmp(directory: string, list: unknown, exported: unknown) {
  const bin = join(directory, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(directory, "list.json"), JSON.stringify(list));
  await writeFile(join(directory, "export.json"), JSON.stringify(exported));
  const executable = join(bin, "amp");
  await writeFile(executable, `#!/bin/sh
if [ "$2" = "list" ]; then cat ${JSON.stringify(join(directory, "list.json"))}; exit 0; fi
if [ "$2" = "export" ]; then cat ${JSON.stringify(join(directory, "export.json"))}; exit 0; fi
exit 2
`);
  await chmod(executable, 0o755);
  return executable;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Amp usage collector", () => {
  it("keeps initial installation identity separate from the collecting installation and rebuilds old caches", async () => {
    const directory = await temporaryDirectory();
    const cachePath = join(directory, "amp.json");
    const threadId = "T-initial-machine";
    await writeFile(join(directory, "device-id.json"), JSON.stringify({ installationID: "collecting-installation" }));
    await writeFile(cachePath, JSON.stringify({ version: 2, threads: {
      [threadId]: { threadId, updated: "2026-09-16T12:00:00Z", rows: [] },
    } }));
    await fakeAmp(directory, [{ id: threadId, updated: "2026-09-16T12:00:00Z" }], {
      id: threadId,
      env: { initial: { hostname: "same-hostname", platform: { installationID: "initial-installation" } } },
      messages: [{ usage: { model: "muse-spark", timestamp: "2026-09-16T12:00:00Z", inputTokens: 3, outputTokens: 2 } }],
    });
    const first = await runScan(directory, cachePath);
    expect(first).toMatchObject({ localInstallationId: "collecting-installation", changedThreadCount: 1 });
    expect(first.threads[0]).toMatchObject({ initialInstallationId: "initial-installation", rows: [expect.objectContaining({ outputTokens: 2 })] });

    await writeFile(join(directory, "device-id.json"), JSON.stringify({ installationID: "new-installation" }));
    const cached = await runScan(directory, cachePath);
    expect(cached).toMatchObject({ localInstallationId: "new-installation", reusedThreadCount: 1 });
    expect(cached.threads).toEqual(first.threads);

    await rm(join(directory, "device-id.json"));
    expect(await runScan(directory, cachePath)).toMatchObject({ localInstallationId: null, failureCount: 0 });
  });

  it("reduces thread exports to token metadata and reuses a content-free cache", async () => {
    const directory = await temporaryDirectory();
    const cachePath = join(directory, "cache", "amp.json");
    const threadId = "T-01a0aa94-f1e7-7610-a400-f8054fe02ad5";
    await fakeAmp(directory, [{ id: threadId, updated: "2026-09-16T12:00:00Z" }], {
      id: threadId,
      env: { initial: { trees: [{ uri: "file:///home/alice/code/private-project", displayName: "private-project" }] } },
      messages: [
        { messageId: 1, role: "user", content: "secret prompt" },
        { messageId: 2, role: "assistant", content: "secret response", usage: {
          model: "gpt-5.6-sol", timestamp: "2026-09-16T00:00:01Z", inputTokens: 40,
          cacheReadInputTokens: 60, cacheCreationInputTokens: 5, outputTokens: 20,
        } },
        { messageId: 4, role: "assistant", usage: {
          model: "gpt-5.6-sol", timestamp: "2026-09-16T12:00:02Z", inputTokens: 10,
          cacheReadInputTokens: 30, cacheCreationInputTokens: 2, outputTokens: 8,
        } },
        { messageId: 6, role: "assistant", usage: {
          model: "gpt-5.6-sol", timestamp: "invalid", inputTokens: 999, outputTokens: 999,
        } },
      ],
    });

    const first = await runScan(directory, cachePath, "America/Los_Angeles");
    expect(first).toMatchObject({ threadCount: 1, changedThreadCount: 1, reusedThreadCount: 0, failureCount: 0 });
    expect(first.threads[0]?.rows).toEqual([{
      threadId,
      day: "2026-09-16",
      modelProviderId: "amp",
      model: "gpt-5.6-sol",
      project: "private-project",
      loggedCostUsd: null,
      uncachedInputTokens: 50,
      cachedInputTokens: 90,
      cacheWriteTokens: 7,
      outputTokens: 28,
    }]);

    const cache = await readFile(cachePath, "utf8");
    expect(cache).not.toContain("secret prompt");
    expect(cache).not.toContain("secret response");
    expect(cache).not.toContain("/home/alice");

    const second = await runScan(directory, cachePath, "Pacific/Auckland");
    expect(second).toMatchObject({ changedThreadCount: 0, reusedThreadCount: 1, failureCount: 0 });
    expect(second.threads).toEqual(first.threads);
  });

  it("retains cached metadata when a changed thread cannot be exported", async () => {
    const directory = await temporaryDirectory();
    const cachePath = join(directory, "cache", "amp.json");
    const threadId = "T-01a0aa94-f1e7-7610-a400-f8054fe02ad5";
    const executable = await fakeAmp(directory, [{ id: threadId, updated: "2026-09-16T12:00:00Z" }], {
      id: threadId,
      env: { initial: {} },
      messages: [{ usage: { model: "muse-spark", timestamp: "2026-09-16T12:00:00Z", inputTokens: 3, outputTokens: 2 } }],
    });
    const first = await runScan(directory, cachePath);

    await writeFile(join(directory, "list.json"), JSON.stringify([{ id: threadId, updated: "2026-09-16T13:00:00Z" }]));
    await writeFile(executable, `#!/bin/sh
if [ "$2" = "list" ]; then cat ${JSON.stringify(join(directory, "list.json"))}; exit 0; fi
exit 1
`);
    const partial = await runScan(directory, cachePath);

    expect(partial).toMatchObject({ threadCount: 1, changedThreadCount: 0, reusedThreadCount: 0, failureCount: 1 });
    expect(partial.error).toBe("An Amp thread export could not be read.");
    expect(partial.threads).toEqual(first.threads);
  });
});
