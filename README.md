# bb-plugin-usage

Track AI usage across Codex, Claude Code, and Grok Agent on all machines enrolled on BB.

![Usage dashboard](https://5kas5z928t.ufs.sh/f/wBHVA4PQTleAMvssUiregkXmOAPY4ndWVuS718FbTZLDztxM)

## Features

- View usage for the last 7, 30, or 90 days.
- Filter by provider and machine.
- Sync automatically every 15 minutes or manually with `Sync now`.

## Supported logs

- Codex: `~/.codex/sessions/**/rollout-*.jsonl`
- Claude Code: `~/.claude/projects/**/*.jsonl`
- Grok Agent: `~/.grok/logs/unified.jsonl`

![Usage by provider](https://5kas5z928t.ufs.sh/f/wBHVA4PQTleAX0mk1Ywqs8NZT3UMHvygFezBaGYxK2w6S1In)

![Usage details](https://5kas5z928t.ufs.sh/f/wBHVA4PQTleAKF31TmIL2VE9DjCy53AWlsMSoTNfqhc0U8Jb)

## Install

Requires BB 0.36 or newer.

```sh
bb plugin install git:https://github.com/MayankBansal12/bb-plugin-usage.git@main --yes
```

Open BB and select **Usage** from the plugin sidebar. The plugin scans supported
logs from connected machines and refreshes automatically.

## Develop

Clone the repository and install dependencies:

```sh
git clone https://github.com/MayankBansal12/bb-plugin-usage.git
cd bb-plugin-usage
npm install
```

Check and build:

```sh
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
