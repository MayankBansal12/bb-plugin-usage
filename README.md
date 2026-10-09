# bb-plugin-usage

Track coding-agent token usage and estimated API cost across every machine enrolled in BB.

![Usage dashboard](https://5kas5z928t.ufs.sh/f/wBHVA4PQTleAMvssUiregkXmOAPY4ndWVuS718FbTZLDztxM)

## Features

- Collect usage from Codex, Claude Code, CodeBuddy, Cursor Agent (opt-in token hook), GitHub Copilot, DeepSeek Harness, Devin, Freebuff, FX, Grok Agent, Kilo Code, OpenCode, Pi, Prime Agent, Antigravity, and Thaura.
- Separate the coding agent from the underlying model provider.
- Group charts and usage shares by agent or model provider.
- Switch the chart and provider shares between cost and tokens.
- Sort breakdowns by tokens or cost using column headers, with each metric’s share shown beneath its value. Unknown costs stay visible without a misleading percentage.
- Break usage down by model, project, or day.
- Filter by machine, agent, model provider, and the last 7, 30, or 90 days.
- Show exact, alias-matched, agent-reported, and unknown pricing in the breakdown table.
- Show Grok Build, OpenCode Go, Claude Code, Cursor, and Codex plan windows in the usage-limits section. The same subscription on several machines is one card with machine tags; different accounts stay separate cards in a horizontal grid.
- Show every Claude and Codex account from BB’s Account Pooler with its account label, reported limit windows, and pool status. Pooled accounts stay visible under every machine filter because the pool is shared. Matching local subscriptions are combined when the account email identifies one pool account; windows from either source are kept, preferring the newer reset cycle and the higher usage within a cycle. Disabled accounts and accounts without reported limits remain visible.
- Resolve model prices from [models.dev](https://models.dev), refreshed daily at runtime with the bundled snapshot as fallback, without inventing prices for ambiguous models.
- Sync automatically every 15 minutes or manually from the dashboard.

## Supported data sources

- Codex: `rollout-*.jsonl` files recursively under both `sessions/` and `archived_sessions/` in `~/.codex` and each `~/.codex-profiles/<name>` home; each profile reports as its own agent, `Codex (<name>)`. Additional homes can be configured in plugin settings.
- Claude Code: `~/.claude/projects/**/*.jsonl`
- CodeBuddy: `~/.codebuddy/projects/**/*.jsonl`. Also honors `CODEBUDDY_CONFIG_DIR` when available in the host scan environment. Counts assistant/API response usage, including tool-call responses; copied messages are deduplicated. Turn summaries, credits, and tool results are not counted.
- Cursor Agent: `~/.cursor/usage.jsonl`, written by the opt-in [token hook](docs/additional-agent-usage.md#cursor-agent-hook). Requires a Cursor CLI version that supplies token counters to `afterAgentResponse`; this records future usage, not historical `store.db` conversations.
- DeepSeek Harness: `~/.dsh/sessions/*/*/session.v3.jsonl.zstd` (Zstandard-compressed JSONL; requires Node.js 22.15+ on the machine)
- Devin: `~/.local/share/devin/cli/sessions.db` — the Devin CLI's SQLite session store, opened read-only (`$XDG_DATA_HOME` is honored). Devin runs in BB through the `acp-devin` provider and writes no JSONL session logs.
- Freebuff: `~/.freebuff/usage.jsonl`, written by the `bb-freebuff` provider bridge, one line per turn it settles through the local freebuff CLI (the CLI keeps no parseable session ledger of its own, so the bridge is the source of truth)
- Kilo Code: `~/.local/share/kilo/kilo.db` — the Kilo CLI's SQLite session store, opened read-only (`$XDG_DATA_HOME` and `APPDATA` are honored). Kilo Code runs in BB through the `kilocode` provider. Its database is the only Kilo Code source: `~/.kilocode/usage.jsonl` is deliberately not scanned, so a bridge-written log cannot double-count turns the database already reports
- FX: `~/.fx/usage.jsonl`
- Grok Agent: `~/.grok/logs/unified.jsonl`
- Pi: `~/.pi/agent/sessions/**/*.jsonl`, plus optional extra roots in plugin settings
- Prime Agent: root sessions in `~/.prime/agent/sessions/*.jsonl` and recursive-agent sessions under `~/.prime/agent/session-artifacts/**/*.jsonl`, plus optional custom session directories in plugin settings
- OpenCode: assistant-message usage from the last 90 days, recorded by `opencode db` (v1) or the read-only local database (v2)
- Antigravity: `~/.antigravity-acp/usage.jsonl`, written by a compatible provider bridge. This is not produced by every `agy` ACP adapter; native agy conversation databases are not a supported token source. See [provider coverage and limitations](docs/additional-agent-usage.md).
- Grok Build limits: credit usage and reset times from the Grok billing endpoint, using the local Grok login (`~/.grok/auth.json`, respecting `GROK_HOME` and `GROK_AUTH_PATH`)
- OpenCode Go limits: plan windows from `https://opencode.ai/zen/go/v1/usage`, authenticated with the `opencode-go` credential in `~/.local/share/opencode/auth.json` on each machine
- Account Pooler limits: non-secret account summaries from the enabled BB `account-pool` plugin’s `account.list` RPC, including Codex limit windows and Claude five-hour, weekly, and model-family limits. API key accounts show that subscription limits are unavailable. This adds quota cards, not per-account token or cost attribution. Pool refresh failures retain the last successful snapshot with a warning; an absent or disabled pool plugin needs no configuration.

JSON-log collection requires Node.js on each enrolled machine. Logs are streamed and reduced to usage metadata on that machine, so large histories are not transferred through BB's file API. A metadata-only per-file cache in `~/.cache/bb-plugin-usage/json-log-scan-v1/` makes later syncs reparse only changed files. The initial 365-day scan can take longer on machines with large histories.

For a custom `CODEX_HOME` outside the default locations, add the home directory to **Extra Codex homes** (`codexHomes`) in the plugin settings. Separate paths with semicolons or newlines; `~` expands to each enrolled machine's home. Both active and archived sessions are scanned, and these extra homes report under Codex. Copies of the same session within an account are counted once. The first sync after upgrading reparses Codex logs to populate session identities in the metadata cache; later syncs reuse unchanged files.

Devin collection requires Node.js 22.13 or newer (for `node:sqlite`) on each enrolled machine. The session database is queried read-only and reduced to per-day token aggregates on the host; only usage metadata fields are extracted, so prompts and message content never leave the machine. A missing database reports as no data, while a database that exists but cannot be read (for example under an older Node.js) surfaces as a sync error for the Devin source only. Devin records ACU totals rather than per-request USD, so its usage shows token counts with unknown cost.

Kilo Code collection has the same Node.js 22.13+ requirement and the same read-only, metadata-only contract: each model request's persisted step usage (v1 `step-finish` parts and v2 `session_message` assistant steps; not the session's lifetime counters) is reduced on the host to per-day token aggregates by the host's local day and the model that served the step (history copied into a forked session is counted once, in its source session), and a missing database reports as no data rather than an error. Kilo Code preserves a step's recorded cost when one is logged and otherwise estimates from models.dev token rates; models without recorded costs or catalog rates remain unknown.

Freebuff history follows the generation ledger that the `bb-freebuff` provider bridge appends to `~/.freebuff/usage.jsonl`, one line per settled turn. The plugin reads usage facts only; Freebuff transcripts and message history are never scanned. Positive recorded costs win over models.dev estimates, and models without recorded costs or catalog rates remain unknown.

FX history follows the rolling retention of FX's local usage ledger. The plugin reads generation usage facts only; FX sessions and prompts are not scanned.

OpenCode v1 collection requires an OpenCode CLI with `opencode db --format json` support. OpenCode v2 collection requires Python 3 on the enrolled machine to read its local SQLite database (the v2 CLI no longer offers `opencode db`). The fixed `SELECT` query aggregates assistant-message usage from the last 90 calendar days—the longest range the dashboard supports—returns only usage metadata, is limited to 900 KB of output, and times out after 60 seconds. OpenCode, Pi, and Prime preserve positive agent-recorded costs and otherwise estimate cost from models.dev token rates. Models without recorded costs or catalog rates remain unknown.

Grok Build limits require Node.js 18+ and a first-party Grok login on the enrolled machine. The collector supports current weekly/monthly credit percentages, legacy monthly budgets, and on-demand caps. Unified credits are labeled as shared across Grok products. Credentials stay on the machine; only normalized limits and a hashed account identity are transferred. API-key-only logins and accounts without a billing plan are skipped. Expired credentials require `grok login`; the plugin does not rotate refresh tokens. The limits card appears only after valid limits have been collected, including 0% usage. First-time failures stay in diagnostics; later failures retain the previous snapshot with a warning. This uses the billing endpoint implemented by [Grok Build](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/billing.rs), which may change between releases.

OpenCode Go limit collection requires `curl` plus either `jq` or Node.js on the enrolled machine, and an OpenCode Go subscription configured in OpenCode's auth file. The API key stays on that machine: the collector reads it locally, calls the usage endpoint, and reports only window percentages and reset times. Machines without a Go credential or plan are skipped silently. Transient failures retain the last successful snapshot and are shown alongside the cached values.

The plugin never stores prompts or message content. It stores timestamps, agent/model identifiers, token buckets, pricing status, and aggregate cost. To break usage down by project it also records the working directory's final segment (the project folder name, e.g. `bb-plugin-usage`) for agents that log one; the full directory path is never stored or transferred. FX uses the spend recorded in its local usage ledger, OpenCode, Pi, and Prime prefer positive agent-recorded costs and fall back to standard API-rate estimates, and other agents use standard API-rate estimates when models.dev can resolve a model, then agent-reported cost when available. CodeBuddy's `-ioa` and Ollama Cloud's `:…-cloud` routing suffixes are resolved to a first-party model rate only when the underlying model matches unambiguously; DeepSeek V4.1 Flash uses its [published base rate](https://api-docs.deepseek.com/quick_start/pricing) when a catalog has not yet added it. These remain estimates, not subscription bills.

Missing log roots are treated as normal “no data” results. Offline machines, unreadable files, malformed collector output, missing runtime tools, query failures, and timeouts are retained as per-agent sync states so available history remains visible with an error notice.

For relocated JSON/JSONL logs, **Extra usage log roots** (`extraUsageRoots`) accepts a JSON object mapping collector IDs to arrays of absolute paths or `~/` paths. Defaults remain enabled, and `~/` expands on each enrolled host. For example: `{"codebuddy":["~/buddy-work/projects"],"cursor":["~/cursor-work/usage.jsonl"]}`. This also works for other JSON collectors such as `claude`, `pi`, or `antigravity`. Configure Codex account separation with the existing `codexProfileHomes` setting instead. A provider-private environment variable or wrapper is not automatically visible to BB's host scan: use explicit roots in that case. No executable installation directory is assumed.

![Usage by provider](https://5kas5z928t.ufs.sh/f/wBHVA4PQTleAX0mk1Ywqs8NZT3UMHvygFezBaGYxK2w6S1In)

![Usage details](https://5kas5z928t.ufs.sh/f/wBHVA4PQTleAKF31TmIL2VE9DjCy53AWlsMSoTNfqhc0U8Jb)

## Install

Requires BB 0.36 or newer.

```sh
bb plugin install git:https://github.com/MayankBansal12/bb-plugin-usage.git@main --yes
```

Open BB and select **Usage** from the plugin sidebar. The plugin scans supported local data on connected machines and refreshes automatically.

## Develop

```sh
git clone https://github.com/MayankBansal12/bb-plugin-usage.git
cd bb-plugin-usage
npm install
npm run check
npm test
npm run build
npm run test:built
```

Host collector functions stay in TypeScript, but run as standalone JavaScript on
enrolled machines. `npm run generate:collectors` compiles their source into the
checked-in `lib/host-scripts.generated.ts` strings before BB bundles the server.
This prevents bundler helpers from leaking into remote commands. Regenerate and
commit that file when changing a host function; `npm test` checks it is current.
`npm run test:built` executes the commands from `dist/server.js` in fresh Node
processes, so production-only packaging failures are covered too.

Install the local build and start development mode:

```sh
bb plugin install . --yes
bb plugin dev
```

## Contributions

Ideas, fixes, and improvements are welcome.

### Cost estimates and unknown pricing

Recorded and unpriced requests are kept in separate aggregate buckets so a recorded cost never suppresses estimates for other requests. Known providers use only their own catalog rates; automatic model aliases are limited to date suffixes. Rows from providers the catalog does not list — typically proxy gateways reporting bare model names — instead resolve the model against first-party vendors, trying the full name before decorated variants such as `-high` or `-expires-on-…`, then a catalog-wide unique match. Unknown models remain unpriced. Costs, charts, and shares cover priced usage only. Catalog estimates use current base token rates, without context-tier adjustments or invoice reconciliation.

### Backlog / WIP

- **Voice cost integration**: Thaura bills audio transcription separately ($0.006 per audio minute via `/v1/audio/transcriptions`), which the token-based ledger does not capture. Track per-call audio minutes alongside tokens (or accept a logged `total_cost` covering them) so voice usage prices correctly.
