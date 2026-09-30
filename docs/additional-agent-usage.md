# Additional ACP agent usage

This plugin collects **reported consumption**, not subscription credits or context
window occupancy. An ACP connection alone does not guarantee token availability:
[ACP `usage_update`](https://agentclientprotocol.com/rfds/session-usage) describes
context size and optional cumulative cost. End-turn token reporting is a separate
optional proposal. The plugin cannot recover counters an agent never exposes.

## Coverage

| Agent | Source | Coverage |
| --- | --- | --- |
| CodeBuddy | Native project JSONL transcripts | Historical and future reported tokens |
| Cursor Agent | Opt-in `afterAgentResponse` token hook | Conditional: future tokens only if the active CLI mode actually invokes the hook with counters |
| Kiro | Investigated session metadata and legacy SQLite | Not supported: inspected token fields are null/zero; credits/context percentages are not substitutes |
| agy | Existing compatible bridge's `usage.jsonl` | Supported only when that bridge actually emits tokens; the inspected `antigravity-acp` adapter does not |

Do not advertise Kiro or arbitrary agy adapters as supported merely because they
appear in BB's provider list. Kiro's current `sessions/cli` metadata exposes
`input_token_count`/`output_token_count` without usable values in the inspected
version. Native agy stores protobuf blobs in its conversation SQLite databases;
the inspected adapter decodes conversation steps, but not generation token usage.
Reliable support requires a documented counter source or an upstream adapter
change. No private database field numbers or installation-specific paths are
guessed here.

## CodeBuddy accounting

The native persisted `message.usage.input_tokens` is an inclusive input total,
unlike Claude Code's uncached input field. Subtract cache reads and writes once.
Explicit raw cache-write counters in `providerData.rawUsage` fill gaps in older
normalized usage. `prompt_cache_miss_tokens` is **not** a cache-write counter.
Deduplicate by response/message identity across content blocks, copied files, and
cached rescans. Never add `turn-metrics.tokenDelta` on top of response usage.
Unrecognized model names retain token counts with unknown cost.

Standard roots are per-host home paths, not CLI installation paths. Use
`extraUsageRoots` for relocated logs or provider-private environment overrides.
The host also honors an absolute `CODEBUDDY_CONFIG_DIR` it can see.

## Cursor Agent hook

Install this hook on **each machine where Cursor runs**. Keep the plugin checkout
or a copy of the standalone hook script at a stable location. Add the entry below
to `~/.cursor/hooks.json`, preserving existing hooks:

```json
{
  "version": 1,
  "hooks": {
    "afterAgentResponse": [
      { "command": "node /absolute/path/to/bb-plugin-usage/scripts/cursor-usage-hook.mjs" }
    ]
  }
}
```

Quote the script path inside the command when it contains spaces. A project-local
`.cursor/hooks.json` is also supported by Cursor, but don't install both copies.
Prefer the global hooks file: ACP builds may not load project hooks from the
workspace root. Start a new Cursor session after changing hook configuration. To remove capture,
remove only this hook entry; existing usage remains readable.

The script needs only Node.js, not a running BB connection or npm dependencies.
For custom storage, append `--output /absolute/path/usage.jsonl` and add that path
under `cursor` in `extraUsageRoots`. `--help` documents the input/output contract.
There is no automatic modification of users' Cursor configuration on plugin load.

The supported CLI hook supplies **uncached** `input_tokens`, `output_tokens`, and
optional `cache_read_tokens`/`cache_write_tokens`. The collector must not subtract
cache a second time. Counters are not present on all Cursor builds: the public
[hook documentation](https://cursor.com/docs/hooks#afteragentresponse) does not
guarantee them. Older builds produce no ledger entries. Missing counters never
become zero-cost fabricated usage, and context-only events are ignored.

Only a hashed response identity, collection timestamp, model, project basename,
and token buckets are saved. Prompts, response text, full paths and credentials
are discarded. Input is bounded, failures do not block a turn, and repeated
delivery is deduplicated by the collector. Recording starts at installation;
the plugin does not infer historical consumption from Cursor's conversation blobs.

The inspected Cursor CLI `2026.09.02-c22c1a3` ACP mode returned only `stopReason`
in a live minimal prompt test and did not invoke the configured test hooks.
Consequently this collector is **not verified as a working source for that ACP
mode**. A working native CLI hook is not evidence that its ACP mode also supports
it. Do not report a successful BB integration until a real ACP turn produces a
ledger row and the row reaches the dashboard.

## Verification and ownership

`lib/additional-agent-usage.test.ts` exercises the serialized host scanner,
cache reuse, response deduplication, raw cache accounting and custom homes.
`lib/cursor-usage-hook.test.ts` drives the standalone script through stdin and
checks privacy, validation and fail-open behavior. `server.test.ts` drives the
public sync RPC and checks that each new agent actually reaches stored usage.

Keep future adapters inside the collector boundary. Preserve the shared
metadata-only host result and pricing flow; do not read unrelated BB databases,
capture raw ACP conversations, or replace credentials/provider commands merely
to manufacture a usage source.
