# Pricing audit — 2026-09-08

Scope: all eight collectors, shared provider/model resolver, host aggregation and cache, OpenCode SQL, catalog lifecycle, dashboard totals, and current live dashboard. Audit only: no additional production changes or reload during this pass. The earlier fallback fix remains installed.

## Confirmed findings

1. **High: aggregation suppresses missing-cost estimates.** Pi and Prime host scans merge requests by day/provider/model/project before choosing recorded cost versus estimated cost (`lib/host-json-collector.ts:154`, `collectors.ts:126`). OpenCode SQL similarly sums recorded cost and all token buckets (`server.ts:507`). A single positive recorded cost prevents fallback for all zero/missing-cost requests in that group. End-to-end Pi reproduction: two requests, one logged at $7 and another with $10 of base-rate tokens but logged as zero, yield $17 through direct parsing and $7 through the real compressed host scanner. Fix: preserve separate recorded-cost and unpriced token buckets through aggregation, or price each request before aggregation. Version the host cache when changing its schema.

2. **High: context pricing tiers are discarded.** `lib/pricing.ts:59` retains only base input/cache/output rates, dropping catalog tiers and `context_over_200k`. All estimated-cost agents are affected for models with tiered rates. Host daily aggregation loses individual request sizes, so applying a tier to the daily total would also be incorrect. Fix: preserve request context size or tier-specific buckets and price at request granularity. Exact model matching currently describes the catalog match, not exact bill accuracy. Service-tier premiums and historical rate changes are also not represented.

3. **Medium: model suffix matching is too permissive.** `lib/pricing.ts:85` aliases any suffix beginning with `-` or `:`. Reproduced an unlisted `base-premium` model receiving `base` rates. Live data includes `gpt-5.6-sol-fast` priced as an alias; this audit does not establish that its rate equals the base model. Fix: limit automatic suffix stripping to documented dated snapshots and maintain explicit verified aliases for other variants.

4. **Medium: cross-provider fallback can substitute another provider's rates and identity.** `lib/pricing.ts:101` searches all providers after a miss even when the logged provider is known. Reproduced an OpenAI request becoming a reseller-priced record when only that reseller lists the model. Fix: respect an explicit provider; infer ownership only for genuinely unknown provider IDs with an unambiguous supported mapping. Do not guess routing-provider prices from model ownership.

5. **Medium: unknown usage silently lowers headline totals.** Model breakdowns now mark unknown/partial costs, but dashboard headline totals, charts, and provider summaries continue summing numeric zero for unknown records. Live data has 276,974,554 Codex tokens labeled `codex-auto-review`; this is not a resolvable billable model identifier. Do not invent a price. Surface excluded usage in summaries and capture the actual response model upstream where available.

6. **Low: catalog cache-write failure loses freshly fetched prices.** `lib/catalog.ts:65` catches persistence errors and claims the in-memory catalog still activates, but no activation occurs there. The next sync only activates the database row. Fix: retain and activate the fetched catalog at the sync boundary even when persistence fails, keeping one consistent catalog throughout a sync.

## Live coverage

| Agent | Stored rows | Unknown rows | Notes |
|---|---:|---:|---|
| OpenCode | 301 | 8 | 1,027,650 unknown tokens, all on offline Fedora; some rows contain no tokens. Earlier Astra and Luna fix verified live. |
| Pi | 48 | 0 | Positive logged costs preserved; mixed-cost aggregation remains a confirmed risk. |
| Codex | 391 | 105 | All unknown rows are `codex-auto-review`. |
| Claude | 77 | 0 | Cache reads/writes kept separate; host scanner deduplicates repeated response IDs. Context tiers remain unsupported. |
| Grok | 2 | 0 | Resolver coverage present; reasoning semantics require checking the exact agent log producer before changing accounting. |
| FX | 7 | 0 | Intentionally uses ledger costs, including zero; not equivalent to the original missing-estimate bug. |
| Prime | 2 | 0 | Same mixed-cost behavior as Pi. |
| Antigravity | 0 | — | Code inspected; no live usage to validate. |

Known free catalog models correctly retain zero pricing. No blanket replacement of zero with paid estimates is appropriate. The dashboard is a current-rate token-cost estimate, not an invoice reconciliation: subscriptions, custom gateways, discounts, tools, modality charges, and historical rate changes may differ.

## Validation and limits

The previous fix passed 123 tests, type checking, and build. This audit additionally executed a temporary Vitest reproduction using the actual compressed host scanner and deterministic catalog fixtures; it reproduced mixed-cost undercounting and unsafe resolver behavior. Temporary test files were removed. No prompts or credentials were inspected. Live unknown pricing counts cover stored history across machines, including an offline host, and do not establish the dollar impact of the identified gaps.

Recommended order: fix mixed-cost aggregation first; tighten provider/model resolution; add request-level tier accounting; make partial totals visible; handle catalog persistence failure. Add regression cases for each before reloading.
