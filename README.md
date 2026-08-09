# bb-plugin-usage

A BB plugin for visualizing local AI-agent usage across provider subscriptions
and enrolled machines.

## Product behavior

- “Subscription” means provider: Codex, Claude Code, or Grok Agent. Account
  identity is deliberately ignored.
- Every connected BB machine is scanned automatically every 15 minutes. The
  `Sync now` button runs the same collection immediately.
- The dashboard offers 7/30/90-day views plus provider and machine filters.
- Dollar values are estimated standard API-equivalent cost, not subscription
  fees or provider invoices.
- No prompts, responses, code, paths, commands, or account data are stored.
  Only timestamps, provider/model names, machine identity, token counts, and
  calculated cost are normalized into the plugin database.

## Local adapters

- Codex: `~/.codex/sessions/**/rollout-*.jsonl`, using `token_count` events.
- Claude Code: `~/.claude/projects/**/*.jsonl`, using assistant-message usage.
- Grok Agent: `~/.grok/logs/unified.jsonl`, using
  `shell.turn.inference_done` metadata.

Machine home directories are resolved by the enrolled daemon; paths are not
assumed to start with `/home/<name>`. Remote files are read through
`bb.sdk.files` with an explicit `hostId`.

Normalized events, opaque source hashes, and event-to-source mappings live in
the plugin SQLite database. Absolute log paths are never persisted. Changed
files are re-parsed atomically; identical events copied across machines are
counted once. A complete scan reconciles moved, deleted, and removed-machine
sources, while truncated or partially unreadable scans preserve prior history
and are marked `partial`. Attempt and successful-sync timestamps are tracked
separately. The browser receives daily/model aggregates rather than raw local
log events.

## Pricing assumptions

The versioned price sheet is in `collectors.ts`. It currently uses standard,
short-context API rates reviewed on 2026-08-09:

- GPT-5.6 Sol: $5 input / $0.50 cached / $30 output per million tokens.
- GPT-5.6 Terra: $2.50 / $0.25 / $15.
- GPT-5.6 Luna: $1 / $0.10 / $6.
- Claude Sonnet 5 introductory rate: $2 / $0.20 / $10; other Claude families
  use their matching public list-price rules.
- Grok Build 0.1: $1 / $0.20 / $2.

Update `PRICING_VERSION` whenever a rate changes. Unknown models intentionally
fall back to a documented family rate so they remain visible, but their cost is
an estimate.

## Develop

```sh
npm install
npm run check
npm test
npm run build
bb plugin install . --yes
bb plugin dev
```

Path installs must be readable by the machine running the BB server. If this
checkout lives only on an enrolled remote machine, publish/install it from a
Git URL or copy the checkout to the server machine first.

Useful commands:

```sh
bb plugin types --check
bb plugin build
bb plugin reload usage
bb plugin logs usage -f
```
