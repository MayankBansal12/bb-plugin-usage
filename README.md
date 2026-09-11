# bb-plugin-usage

Track coding-agent token usage and estimated API cost across every machine enrolled in BB.

![Usage dashboard](https://5kas5z928t.ufs.sh/f/wBHVA4PQTleAMvssUiregkXmOAPY4ndWVuS718FbTZLDztxM)

## Features

- Collect usage from Codex, Claude Code, DeepSeek Harness, Devin, FX, Grok Agent, OpenCode, Pi, Prime Agent, Antigravity, and Thaura.
- Separate the coding agent from the underlying model provider.
- Group charts and cost summaries by agent or model provider.
- Break usage down by model, project, or day.
- Filter by machine, agent, model provider, and the last 7, 30, or 90 days.
- Show exact, alias-matched, agent-reported, and unknown pricing in the breakdown table.
- Show Grok Build, OpenCode Go, Claude Code, Cursor, and Codex plan windows in the usage-limits section. The same subscription on several machines is one card with machine tags; different accounts stay separate cards in a horizontal grid.
- Resolve model prices from [models.dev](https://models.dev), refreshed daily at runtime with the bundled snapshot as fallback, without inventing prices for ambiguous models.
- Sync automatically every 15 minutes or manually from the dashboard.

## Supported data sources

- Codex: `~/.codex/sessions/**/rollout-*.jsonl`, plus `~/.codex-profiles/*/sessions/**/rollout-*.jsonl` for extra Codex accounts exposed as ACP providers (e.g. by multi-account bridges); each profile reports as its own agent, `Codex (<name>)`
- Claude Code: `~/.claude/projects/**/*.jsonl`
- DeepSeek Harness: `~/.dsh/sessions/*/*/session.v3.jsonl.zstd` (Zstandard-compressed JSONL; requires Node.js 22.15+ on the machine)
- Devin: `~/.local/share/devin/cli/sessions.db` — the Devin CLI's SQLite session store, opened read-only (`$XDG_DATA_HOME` is honored). Devin runs in BB through the `acp-devin` provider and writes no JSONL session logs.
- FX: `~/.fx/usage.jsonl`
- Grok Agent: `~/.grok/logs/unified.jsonl`
- Pi: `~/.pi/agent/sessions/**/*.jsonl`, plus optional extra roots in plugin settings
- Prime Agent: root sessions in `~/.prime/agent/sessions/*.jsonl` and recursive-agent sessions under `~/.prime/agent/session-artifacts/**/*.jsonl`, plus optional custom session directories in plugin settings
- OpenCode: assistant-message usage from the last 90 days, recorded by `opencode db`
- Antigravity: `~/.antigravity-acp/usage.jsonl`, written by the `bb-plugin-antigravity-acp` provider bridge (the `agy` CLI has no session log of its own in a stable, parseable shape, so the bridge is the source of truth, one line per turn it runs)
- Grok Build limits: credit usage and reset times from the Grok billing endpoint, using the local Grok login (`~/.grok/auth.json`, respecting `GROK_HOME` and `GROK_AUTH_PATH`)
- OpenCode Go limits: plan windows from `https://opencode.ai/zen/go/v1/usage`, authenticated with the `opencode-go` credential in `~/.local/share/opencode/auth.json` on each machine

JSON-log collection requires Node.js on each enrolled machine. Logs are streamed and reduced to usage metadata on that machine, so large histories are not transferred through BB's file API. A metadata-only per-file cache in `~/.cache/bb-plugin-usage/json-log-scan-v1/` makes later syncs reparse only changed files. The initial 365-day scan can take longer on machines with large histories.

Devin collection requires Node.js 22.13 or newer (for `node:sqlite`) on each enrolled machine. The session database is queried read-only and reduced to per-day token aggregates on the host; only usage metadata fields are extracted, so prompts and message content never leave the machine. A missing database reports as no data, while a database that exists but cannot be read (for example under an older Node.js) surfaces as a sync error for the Devin source only. Devin records ACU totals rather than per-request USD, so its usage shows token counts with unknown cost.

FX history follows the rolling retention of FX's local usage ledger. The plugin reads generation usage facts only; FX sessions and prompts are not scanned.

OpenCode collection requires an OpenCode CLI with `opencode db --format json` support on each enrolled machine. The fixed `SELECT` query aggregates assistant-message usage from the last 90 calendar days—the longest range the dashboard supports—returns only usage metadata, is limited to 900 KB of output, and times out after 60 seconds. OpenCode, Pi, and Prime preserve positive agent-recorded costs and otherwise estimate cost from models.dev token rates. Models without recorded costs or catalog rates remain unknown.

Grok Build limits require Node.js 18+ and a first-party Grok login on the enrolled machine. The collector supports current weekly/monthly credit percentages, legacy monthly budgets, and on-demand caps. Unified credits are labeled as shared across Grok products. Credentials stay on the machine; only normalized limits and a hashed account identity are transferred. API-key-only logins and accounts without a billing plan are skipped. Expired credentials require `grok login`; the plugin does not rotate refresh tokens. The limits card appears only after valid limits have been collected, including 0% usage. First-time failures stay in diagnostics; later failures retain the previous snapshot with a warning. This uses the billing endpoint implemented by [Grok Build](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/billing.rs), which may change between releases.

OpenCode Go limit collection requires `curl` plus either `jq` or Node.js on the enrolled machine, and an OpenCode Go subscription configured in OpenCode's auth file. The API key stays on that machine: the collector reads it locally, calls the usage endpoint, and reports only window percentages and reset times. Machines without a Go credential or plan are skipped silently. Transient failures retain the last successful snapshot and are shown alongside the cached values.

The plugin never stores prompts or message content. It stores timestamps, agent/model identifiers, token buckets, pricing status, and aggregate cost. To break usage down by project it also records the working directory's final segment (the project folder name, e.g. `bb-plugin-usage`) for agents that log one; the full directory path is never stored or transferred. FX uses the spend recorded in its local usage ledger, OpenCode, Pi, and Prime prefer positive agent-recorded costs and fall back to standard API-rate estimates, and other agents use standard API-rate estimates when models.dev can resolve a model, then agent-reported cost when available. They are not subscription-billing totals.

Missing log roots are treated as normal “no data” results. Offline machines, unreadable files, malformed collector output, missing runtime tools, query failures, and timeouts are retained as per-agent sync states so available history remains visible with an error notice.

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
```

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
