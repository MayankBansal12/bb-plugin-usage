# bb-plugin-usage

Track coding-agent token usage and estimated API cost across every machine enrolled in BB.

![Usage dashboard](https://5kas5z928t.ufs.sh/f/wBHVA4PQTleAMvssUiregkXmOAPY4ndWVuS718FbTZLDztxM)

## Features

- Collect usage from Codex, Claude Code, FX, Grok Agent, OpenCode, Pi, Prime Agent, and Antigravity.
- Separate the coding agent from the underlying model provider.
- Group charts and cost summaries by agent or model provider.
- Break usage down by model, project, or day.
- Filter by machine, agent, model provider, and the last 7, 30, or 90 days.
- Show exact, alias-matched, agent-reported, and unknown pricing in the breakdown table.
- Show OpenCode Go plan windows (rolling 5-hour, weekly, and monthly) in the usage-limits section.
- Resolve model prices from [models.dev](https://models.dev), refreshed daily at runtime with the bundled snapshot as fallback, without inventing prices for ambiguous models.
- Sync automatically every 15 minutes or manually from the dashboard.

## Supported data sources

- Codex: `~/.codex/sessions/**/rollout-*.jsonl`
- Claude Code: `~/.claude/projects/**/*.jsonl`
- FX: `~/.fx/usage.jsonl`
- Grok Agent: `~/.grok/logs/unified.jsonl`
- Pi: `~/.pi/agent/sessions/**/*.jsonl`, plus optional extra roots in plugin settings
- Prime Agent: root sessions in `~/.prime/agent/sessions/*.jsonl` and recursive-agent sessions under `~/.prime/agent/session-artifacts/**/*.jsonl`, plus optional custom session directories in plugin settings
- OpenCode: assistant-message usage from the last 90 days, recorded by `opencode db`
- Antigravity: `~/.antigravity-acp/usage.jsonl`, written by the `bb-plugin-antigravity-acp` provider bridge (the `agy` CLI has no session log of its own in a stable, parseable shape, so the bridge is the source of truth, one line per turn it runs)
- OpenCode Go limits: plan windows from `https://opencode.ai/zen/go/v1/usage`, authenticated with the `opencode-go` credential in `~/.local/share/opencode/auth.json` on each machine

JSON-log collection requires Node.js on each enrolled machine. Logs are streamed and reduced to usage metadata on that machine, so large histories are not transferred through BB's file API. A metadata-only per-file cache in `~/.cache/bb-plugin-usage/json-log-scan-v1/` makes later syncs reparse only changed files. The initial 365-day scan can take longer on machines with large histories.

FX history follows the rolling retention of FX's local usage ledger. The plugin reads generation usage facts only; FX sessions and prompts are not scanned.

OpenCode collection requires an OpenCode CLI with `opencode db --format json` support on each enrolled machine. The fixed `SELECT` query aggregates assistant-message usage from the last 90 calendar days—the longest range the dashboard supports—returns only usage metadata, is limited to 900 KB of output, and times out after 60 seconds. OpenCode costs use only positive values recorded by OpenCode; providers with no recorded cost remain unknown with zero cost.

OpenCode Go limit collection requires `curl` plus either `jq` or Node.js on the enrolled machine, and an OpenCode Go subscription configured in OpenCode's auth file. The API key stays on that machine: the collector reads it locally, calls the usage endpoint, and reports only window percentages and reset times. Machines without a Go credential or plan are skipped silently. Transient failures retain the last successful snapshot and are shown alongside the cached values.

The plugin never stores prompts or message content. It stores timestamps, agent/model identifiers, token buckets, pricing status, and aggregate cost. To break usage down by project it also records the working directory's final segment (the project folder name, e.g. `bb-plugin-usage`) for agents that log one; the full directory path is never stored or transferred. FX uses the spend recorded in its local usage ledger, OpenCode uses positive agent-recorded costs only, and other agents use standard API-rate estimates when models.dev can resolve a model, then agent-reported cost when available. They are not subscription-billing totals.

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
