# GitHub Copilot CLI accounting

Copilot CLI persists `session.shutdown` events under
`~/.copilot/session-state/**/events.jsonl`. Its published event type defines
`data.modelMetrics` as cumulative per-model input, output, cache-read, and
cache-write token totals for the completed session. The input total includes
cache reads and writes, so the collector subtracts both once when deriving
uncached input. It reads only those totals, the close timestamp, the
session-start project basename, and a hashed event identity. It ignores
checkpoint, context-window, premium-request, and code-change fields;
premium-request cost multipliers are not USD prices.

An open session has no final cumulative event, so it is intentionally omitted
until Copilot closes it. Session totals are attributed to that close date: the
native log does not provide a per-request timestamped token ledger that could
allocate a multi-day session more precisely.

The collector reads local logs directly and does not execute Copilot or require
Copilot authentication. Missing or empty session roots produce no usage records
and no scan error. Existing logs remain readable after the CLI is uninstalled.
Only Copilot caches are migrated for this accounting change; other agents retain
their existing cache versions.
