# bb-plugin-usage

Track coding-agent token usage and estimated API cost across every machine enrolled in BB.

![Usage dashboard](https://5kas5z928t.ufs.sh/f/wBHVA4PQTleAMvssUiregkXmOAPY4ndWVuS718FbTZLDztxM)

## Features

- Collect usage from Codex, Claude Code, Grok Agent, OpenCode, Pi, and Prime Agent.
- Separate the coding agent from the underlying model provider.
- Group charts and cost summaries by agent or model provider.
- Filter by machine, agent, model provider, and the last 7, 30, or 90 days.
- Show exact, alias-matched, agent-reported, and unknown pricing in the breakdown table.
- Resolve model prices from [models.dev](https://models.dev), refreshed daily at runtime with the bundled snapshot as fallback, without inventing prices for ambiguous models.
- Sync automatically every 15 minutes or manually from the dashboard.

## Supported data sources

- Codex: `~/.codex/sessions/**/rollout-*.jsonl`
- Claude Code: `~/.claude/projects/**/*.jsonl`
- Grok Agent: `~/.grok/logs/unified.jsonl`
- Pi: `~/.pi/agent/sessions/**/*.jsonl`, plus optional extra roots in plugin settings
- Prime Agent: root sessions in `~/.prime/agent/sessions/*.jsonl` and recursive-agent sessions under `~/.prime/agent/session-artifacts/**/*.jsonl`, plus optional custom session directories in plugin settings
- OpenCode: assistant-message usage from the last 90 days, recorded by `opencode db`

JSON-log collection requires Node.js on each enrolled machine. Logs are streamed and reduced to usage metadata on that machine, so large histories are not transferred through BB's file API. A metadata-only per-file cache in `~/.cache/bb-plugin-usage/json-log-scan-v1/` makes later syncs reparse only changed files. The initial 365-day scan can take longer on machines with large histories.

OpenCode collection requires an OpenCode CLI with `opencode db --format json` support on each enrolled machine. The fixed `SELECT` query aggregates assistant-message usage from the last 90 calendar days—the longest range the dashboard supports—returns only usage metadata, is limited to 900 KB of output, and times out after 60 seconds. OpenCode costs use only positive values recorded by OpenCode; providers with no recorded cost remain unknown with zero cost.

The plugin never stores prompts or message content. It stores timestamps, agent/model identifiers, token buckets, pricing status, and aggregate cost. OpenCode uses positive agent-recorded costs only; other agents use standard API-rate estimates when models.dev can resolve a model, then agent-reported cost when available. They are not subscription-billing totals.

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
