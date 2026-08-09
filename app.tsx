import { useEffect, useMemo, useRef, useState } from "react";
import { definePluginApp, useRealtime, useRealtimeConnectionState, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Icon } from "@/components/ui/icon";

type Range = 7 | 30 | 90;
type ChartMode = "cost" | "tokens";
type BreakdownMode = "model" | "day";

type UsageRecord = {
  day: string;
  providerId: string;
  providerName: string;
  machineId: string;
  machineName: string;
  model: string;
  costUsd: number;
  cacheSavingsUsd: number;
  processedTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
};

type DashboardData = {
  mode: "live";
  generatedAt: string;
  lastSyncedAt: string | null;
  pricingVersion: string;
  machines: Array<{ id: string; name: string; status?: string }>;
  providers: Array<{ id: string; name: string; status?: string }>;
  records: UsageRecord[];
  sources: Array<{
    machineId: string;
    providerId: string;
    status: string;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    recordCount: number;
    error: string | null;
  }>;
  notice: string;
};

const PROVIDER_COLORS = ["var(--foreground)", "var(--chart-2)", "var(--chart-3)"];

function money(value: number) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value > 0 && value < 1 ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(value);
}

function compact(value: number) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function percentage(value: number, total: number) {
  return total > 0 ? `${((value / total) * 100).toFixed(1)}%` : "0.0%";
}

function parseDay(day: string) {
  return new Date(`${day}T00:00:00Z`);
}

function formatDay(day: string, includeYear = false) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(parseDay(day));
}

function rangeDays(range: Range) {
  const today = new Date();
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  return Array.from({ length: range }, (_, index) => {
    const day = new Date(end);
    day.setUTCDate(end.getUTCDate() - range + index + 1);
    return day.toISOString().slice(0, 10);
  });
}

function niceMaximum(value: number) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

function smoothPath(points: Array<{ x: number; y: number }>, top: number, bottom: number) {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  const clampY = (value: number) => Math.max(top, Math.min(bottom, value));
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[Math.max(0, index - 1)];
    const current = points[index];
    const next = points[index + 1];
    const following = points[Math.min(points.length - 1, index + 2)];
    const control1X = current.x + (next.x - previous.x) / 6;
    const control1Y = clampY(current.y + (next.y - previous.y) / 6);
    const control2X = next.x - (following.x - current.x) / 6;
    const control2Y = clampY(next.y - (following.y - current.y) / 6);
    path += ` C ${control1X} ${control1Y}, ${control2X} ${control2Y}, ${next.x} ${next.y}`;
  }
  return path;
}

function SegmentedControl<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="inline-flex h-9 items-center rounded-lg border border-border bg-muted/20 p-0.5" role="tablist" aria-label={label}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={`h-8 rounded-md px-3 text-xs font-medium transition-[background-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.97] ${
              active
                ? "bg-background text-foreground shadow-sm ring-1 ring-border/70"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function SelectFilter({
  value,
  onChange,
  label,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-xs text-muted-foreground focus-within:ring-1 focus-within:ring-ring">
      <span className="hidden sm:inline">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 cursor-pointer bg-transparent font-medium text-foreground outline-none"
      >
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function UsageChart({
  records,
  providers,
  range,
  mode,
}: {
  records: UsageRecord[];
  providers: Array<{ id: string; name: string }>;
  range: Range;
  mode: ChartMode;
}) {
  const width = 980;
  const height = 300;
  const inset = { top: 14, right: 8, bottom: 32, left: 62 };
  const days = rangeDays(range);
  const totalsByKey = new Map<string, number>();

  for (const record of records) {
    const key = `${record.day}:${record.providerId}`;
    const value = mode === "cost" ? record.costUsd : record.processedTokens;
    totalsByKey.set(key, (totalsByKey.get(key) ?? 0) + value);
  }

  const series = providers.map((provider) => ({
    ...provider,
    values: days.map((day) => totalsByKey.get(`${day}:${provider.id}`) ?? 0),
  }));
  const rawMaximum = Math.max(0, ...series.flatMap((item) => item.values));
  const maximum = niceMaximum(rawMaximum);
  const chartWidth = width - inset.left - inset.right;
  const chartHeight = height - inset.top - inset.bottom;
  const x = (index: number) => inset.left + (index / Math.max(1, days.length - 1)) * chartWidth;
  const y = (value: number) => inset.top + chartHeight - (value / maximum) * chartHeight;
  const formatValue = mode === "cost" ? money : compact;

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="min-w-[680px] w-full" role="img" aria-label={`Daily ${mode} by provider`}>
        <defs>
          {providers.map((provider, index) => (
            <linearGradient key={provider.id} id={`usage-area-${provider.id}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={PROVIDER_COLORS[index % PROVIDER_COLORS.length]} stopOpacity="0.16" />
              <stop offset="100%" stopColor={PROVIDER_COLORS[index % PROVIDER_COLORS.length]} stopOpacity="0" />
            </linearGradient>
          ))}
          <clipPath id="usage-chart-clip">
            <rect x={inset.left} y={inset.top} width={chartWidth} height={chartHeight} />
          </clipPath>
        </defs>

        {[0, 0.25, 0.5, 0.75, 1].map((step) => {
          const value = maximum * step;
          return (
            <g key={step}>
              <line
                x1={inset.left}
                x2={width - inset.right}
                y1={y(value)}
                y2={y(value)}
                className="stroke-border/70"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
              <text x={inset.left - 12} y={y(value) + 4} textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">
                {formatValue(value)}
              </text>
            </g>
          );
        })}

        <g clipPath="url(#usage-chart-clip)">
          {series.map((item, seriesIndex) => {
            const points = item.values.map((value, index) => ({ x: x(index), y: y(value) }));
            const line = smoothPath(points, inset.top, inset.top + chartHeight);
            const area = `${line} L ${x(days.length - 1)} ${y(0)} L ${x(0)} ${y(0)} Z`;
            return (
              <g key={item.id}>
                <path d={area} fill={`url(#usage-area-${item.id})`} />
                <path
                  d={line}
                  fill="none"
                  stroke={PROVIDER_COLORS[seriesIndex % PROVIDER_COLORS.length]}
                  strokeWidth="2.25"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}
        </g>

        {[0, Math.floor((days.length - 1) / 2), days.length - 1].map((index, labelIndex) => (
          <text
            key={`${days[index]}:${labelIndex}`}
            x={x(index)}
            y={height - 7}
            textAnchor={labelIndex === 0 ? "start" : labelIndex === 2 ? "end" : "middle"}
            className="fill-muted-foreground text-[11px] uppercase"
          >
            {formatDay(days[index])}
          </text>
        ))}
      </svg>
    </div>
  );
}

function UsageDashboard() {
  const rpc = useRpc<typeof rpcContract>();
  const realtimeState = useRealtimeConnectionState();
  const hasConnected = useRef(false);
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<Range>(30);
  const [provider, setProvider] = useState("all");
  const [machine, setMachine] = useState("all");
  const [chartMode, setChartMode] = useState<ChartMode>("cost");
  const [breakdownMode, setBreakdownMode] = useState<BreakdownMode>("model");
  const [syncing, setSyncing] = useState(false);

  const load = () => {
    setError(null);
    void rpc.call("dashboard").then(setData).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  const sync = () => {
    setSyncing(true);
    setError(null);
    void rpc.call("sync")
      .then(() => rpc.call("dashboard"))
      .then(setData)
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setSyncing(false));
  };

  useEffect(load, []);
  useRealtime("usage-updated", load);
  useEffect(() => {
    if (realtimeState !== "connected") return;
    if (hasConnected.current) load();
    else hasConnected.current = true;
  }, [realtimeState]);

  const rows = useMemo(() => {
    if (!data) return [];
    const days = rangeDays(range);
    const cutoffDay = days[0];
    return data.records.filter((row) =>
      row.day >= cutoffDay
      && (provider === "all" || row.providerId === provider)
      && (machine === "all" || row.machineId === machine));
  }, [data, machine, provider, range]);

  const totals = useMemo(() => rows.reduce((sum, row) => ({
    cost: sum.cost + row.costUsd,
    processed: sum.processed + row.processedTokens,
    cached: sum.cached + row.cachedInputTokens,
    cacheWrites: sum.cacheWrites + row.cacheWriteTokens,
    cacheSavings: sum.cacheSavings + row.cacheSavingsUsd,
    uncached: sum.uncached + row.uncachedInputTokens,
    output: sum.output + row.outputTokens,
  }), { cost: 0, processed: 0, cached: 0, cacheWrites: 0, cacheSavings: 0, uncached: 0, output: 0 }), [rows]);

  const modelBreakdown = useMemo(() => {
    const map = new Map<string, { key: string; label: string; provider: string; providerId: string; cost: number; tokens: number }>();
    for (const row of rows) {
      const key = `${row.providerId}:${row.model}`;
      const current = map.get(key) ?? { key, label: row.model, provider: row.providerName, providerId: row.providerId, cost: 0, tokens: 0 };
      current.cost += row.costUsd;
      current.tokens += row.processedTokens;
      map.set(key, current);
    }
    return [...map.values()].sort((a, b) => b.cost - a.cost);
  }, [rows]);

  const dayBreakdown = useMemo(() => {
    const map = new Map<string, { key: string; label: string; provider: string; providerId: string; cost: number; tokens: number }>();
    for (const row of rows) {
      const current = map.get(row.day) ?? { key: row.day, label: formatDay(row.day, true), provider: "All providers", providerId: "all", cost: 0, tokens: 0 };
      current.cost += row.costUsd;
      current.tokens += row.processedTokens;
      map.set(row.day, current);
    }
    return [...map.values()].sort((a, b) => b.key.localeCompare(a.key));
  }, [rows]);

  if (error) {
    return <div className="flex h-full items-center justify-center p-8 text-sm text-destructive">Could not load usage: {error}</div>;
  }
  if (!data) {
    return <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">Loading usage…</div>;
  }

  const days = rangeDays(range);
  const activeProviders = data.providers.filter((item) => provider === "all" || item.id === provider);
  const providerTotals = activeProviders.map((item) => ({
    ...item,
    cost: rows.filter((row) => row.providerId === item.id).reduce((sum, row) => sum + row.costUsd, 0),
    tokens: rows.filter((row) => row.providerId === item.id).reduce((sum, row) => sum + row.processedTokens, 0),
  }));
  const visibleSources = data.sources.filter((source) =>
    (provider === "all" || source.providerId === provider)
    && (machine === "all" || source.machineId === machine));
  const sourceIssues = visibleSources.filter((source) => !["ready", "no-data"].includes(source.status));
  const breakdown = breakdownMode === "model" ? modelBreakdown : dayBreakdown;
  const activeDays = new Set(rows.map((row) => row.day)).size;

  const metrics = [
    { label: "Processed tokens", value: compact(totals.processed), detail: `${compact(totals.processed / Math.max(1, activeDays))} per active day` },
    { label: "Cached input", value: compact(totals.cached), detail: `${percentage(totals.cached, totals.cached + totals.uncached)} of observed input` },
    { label: "Uncached input", value: compact(totals.uncached), detail: `${compact(totals.cacheWrites)} cache writes` },
    { label: "Output", value: compact(totals.output), detail: "Includes reasoning tokens" },
    { label: "Cache savings", value: money(totals.cacheSavings), detail: totals.cost > 0 ? `${(totals.cacheSavings / totals.cost).toFixed(1)}× the raw token cost` : `Price sheet ${data.pricingVersion}` },
  ];

  return (
    <div className="h-full overflow-y-auto bg-background">
      <main className="mx-auto w-full max-w-[1480px] px-5 py-6 md:px-8 md:py-7">
        <header className="flex flex-col gap-5 border-b border-border/70 pb-6 md:flex-row md:items-start md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Usage</h1>
            <p className="mt-1 text-sm text-muted-foreground">{formatDay(days[0])} to {formatDay(days[days.length - 1])}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <SelectFilter
              label="Provider"
              value={provider}
              onChange={setProvider}
              options={[{ value: "all", label: "All providers" }, ...data.providers.map((item) => ({ value: item.id, label: item.name }))]}
            />
            <SelectFilter
              label="Machine"
              value={machine}
              onChange={setMachine}
              options={[{ value: "all", label: "All machines" }, ...data.machines.map((item) => ({ value: item.id, label: item.name }))]}
            />
            <SegmentedControl
              value={range}
              onChange={setRange}
              label="Date range"
              options={[7, 30, 90].map((value) => ({ value: value as Range, label: `${value} days` }))}
            />
            <button
              type="button"
              onClick={sync}
              disabled={syncing}
              aria-label="Sync usage now"
              title={data.lastSyncedAt ? `Last synced ${new Date(data.lastSyncedAt).toLocaleString()}` : "Sync usage now"}
              className="flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-[background-color,color,transform] duration-150 ease-out hover:bg-muted/50 hover:text-foreground active:scale-[0.96] disabled:cursor-wait disabled:opacity-50"
            >
              <Icon name="RotateCcw" className={`size-4 ${syncing ? "animate-spin" : ""}`} aria-hidden="true" />
            </button>
          </div>
        </header>

        {sourceIssues.length > 0 && (
          <div className="mt-5 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
            <Icon name="AlertTriangle" className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden="true" />
            <span>{sourceIssues.length} source{sourceIssues.length === 1 ? "" : "s"} reported partial or unavailable history. Available records are still included.</span>
          </div>
        )}

        {rows.length === 0 ? (
          <div className="flex min-h-[420px] flex-col items-center justify-center border-b border-border text-center">
            <div className="text-sm font-medium">No usage in this view</div>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">Try a wider date range, another filter, or sync connected machines.</p>
          </div>
        ) : (
          <>
            <section className="grid gap-8 py-8 lg:grid-cols-[minmax(250px,0.7fr)_minmax(0,1.8fr)] lg:gap-12">
              <div className="pt-1">
                <div className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">Raw token cost</div>
                <div className="mt-2 text-4xl font-semibold tracking-tight tabular-nums md:text-[42px]">{money(totals.cost)}*</div>
                <div className="mt-1 text-sm text-muted-foreground">If billed at standard API rates</div>

                <div className="mt-7 space-y-5">
                  {providerTotals.map((item, index) => (
                    <div key={item.id}>
                      <div className="flex items-center justify-between gap-4 text-sm">
                        <span className="flex min-w-0 items-center gap-2 font-medium">
                          <span className="size-2 rounded-full" style={{ backgroundColor: PROVIDER_COLORS[index % PROVIDER_COLORS.length] }} />
                          <span className="truncate">{item.name}</span>
                        </span>
                        <span className="tabular-nums">{money(item.cost)}</span>
                      </div>
                      <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full transition-[width] duration-200 ease-out"
                          style={{
                            width: `${totals.cost ? (item.cost / totals.cost) * 100 : 0}%`,
                            backgroundColor: PROVIDER_COLORS[index % PROVIDER_COLORS.length],
                          }}
                        />
                      </div>
                      <div className="mt-2 text-xs text-muted-foreground">{percentage(item.cost, totals.cost)} of cost · {compact(item.tokens)} tokens</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="min-w-0">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold">Daily {chartMode === "cost" ? "cost" : "tokens"}</h2>
                  <div className="flex flex-wrap items-center gap-4">
                    <SegmentedControl
                      value={chartMode}
                      onChange={setChartMode}
                      label="Chart value"
                      options={[{ value: "cost", label: "Cost" }, { value: "tokens", label: "Tokens" }]}
                    />
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      {activeProviders.map((item, index) => (
                        <span key={item.id} className="flex items-center gap-1.5">
                          <span className="size-2 rounded-full" style={{ backgroundColor: PROVIDER_COLORS[index % PROVIDER_COLORS.length] }} />
                          {item.name}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="mt-3">
                  <UsageChart records={rows} providers={activeProviders} range={range} mode={chartMode} />
                </div>
              </div>
            </section>

            <section className="overflow-x-auto border-y border-border">
              <div className="grid min-w-[820px] grid-cols-5 divide-x divide-border">
                {metrics.map((metric) => (
                  <div key={metric.label} className="px-5 py-4 first:pl-0 last:pr-0 md:px-6">
                    <div className="text-xs text-muted-foreground">{metric.label}</div>
                    <div className="mt-1 text-xl font-medium tabular-nums">{metric.value}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{metric.detail}</div>
                  </div>
                ))}
              </div>
            </section>

            <section className="py-8">
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-base font-semibold">Breakdown</h2>
                <SegmentedControl
                  value={breakdownMode}
                  onChange={setBreakdownMode}
                  label="Breakdown grouping"
                  options={[{ value: "model", label: "Model" }, { value: "day", label: "Day" }]}
                />
              </div>

              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[680px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs text-muted-foreground">
                      <th className="pb-3 text-left font-normal">{breakdownMode === "model" ? "Model" : "Day"}</th>
                      <th className="pb-3 text-left font-normal">Provider</th>
                      <th className="pb-3 text-right font-normal">Cost</th>
                      <th className="pb-3 text-right font-normal">Share</th>
                      <th className="pb-3 text-right font-normal">Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {breakdown.map((row) => (
                      <tr key={row.key} className="border-b border-border/60 last:border-0">
                        <td className="py-3 font-medium">{row.label}</td>
                        <td className="py-3 text-muted-foreground">{row.provider}</td>
                        <td className="py-3 text-right tabular-nums">{money(row.cost)}</td>
                        <td className="py-3 text-right tabular-nums text-muted-foreground">{percentage(row.cost, totals.cost)}</td>
                        <td className="py-3 text-right tabular-nums text-muted-foreground">{compact(row.tokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        <footer className="border-t border-border/70 pt-4 text-xs text-muted-foreground">
          {data.notice} Price sheet {data.pricingVersion}.
        </footer>
      </main>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "usage", title: "Usage", icon: "ChartColumn", path: "usage", component: UsageDashboard });
});
