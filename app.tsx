import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { definePluginApp, useRealtime, useRealtimeConnectionState, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Icon } from "@/components/ui/icon";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { paginateItems } from "@/lib/pagination";

type Range = 7 | 30 | 90;
type ChartMode = "cost" | "tokens";
type BreakdownMode = "model" | "day";

const BREAKDOWN_PAGE_SIZE = 10;

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

const PROVIDER_COLORS: Record<string, string> = {
  codex: "#10A37F",
  claude: "#D97757",
  grok: "#6E7CF6",
  cursor: "#A855F7",
};

const FALLBACK_PROVIDER_COLORS = ["#0EA5E9", "#F59E0B", "#EC4899", "#14B8A6"];

function providerColor(providerId: string) {
  const normalizedId = providerId.toLowerCase();
  if (PROVIDER_COLORS[normalizedId]) return PROVIDER_COLORS[normalizedId];
  let hash = 0;
  for (const character of normalizedId) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return FALLBACK_PROVIDER_COLORS[Math.abs(hash) % FALLBACK_PROVIDER_COLORS.length];
}

type HeaderControlsState = {
  machine: string;
  range: Range;
  machines: DashboardData["machines"];
  dateLabel: string;
  syncing: boolean;
  lastSyncedAt: string | null;
  setMachine: (value: string) => void;
  setRange: (value: Range) => void;
  sync: () => void;
};

let headerControlsState: HeaderControlsState | null = null;
const headerControlsListeners = new Set<() => void>();

function publishHeaderControls(next: HeaderControlsState | null) {
  headerControlsState = next;
  for (const listener of headerControlsListeners) listener();
}

function useHeaderControls() {
  return useSyncExternalStore(
    (listener) => {
      headerControlsListeners.add(listener);
      return () => headerControlsListeners.delete(listener);
    },
    () => headerControlsState,
    () => null,
  );
}

function money(value: number) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
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

function ToggleGroup<T extends string | number>({
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
    <div className="inline-flex h-8 items-center rounded-md border border-border/70 bg-muted/30 p-0.5" role="group" aria-label={label}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`inline-flex h-6 items-center justify-center rounded-[5px] px-2.5 text-xs font-medium leading-none transition-[background-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.97] ${
              active
                ? "bg-background text-foreground shadow-sm"
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

function MachineFilter({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        aria-label="Filter usage by machine"
        className="h-8 border-border/70 bg-muted/20 px-2.5 py-0 text-xs font-medium shadow-none hover:bg-muted/40 focus:ring-1 data-[state=open]:bg-muted/40 [&>svg]:size-3.5 [&>svg]:opacity-60"
        style={{ width: 180 }}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        align="end"
        sideOffset={4}
        className="[&_[role=option]>span:last-child]:truncate"
        style={{ width: "var(--radix-select-trigger-width)", minWidth: "var(--radix-select-trigger-width)" }}
      >
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} className="text-xs">
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function UsageHeaderControls() {
  const controls = useHeaderControls();
  if (!controls) return null;

  return (
    <div className="hidden items-center gap-2 md:flex">
      <ToggleGroup
        value={controls.range}
        onChange={controls.setRange}
        label={`Date range, ${controls.dateLabel}`}
        options={[7, 30, 90].map((value) => ({ value: value as Range, label: `${value} days` }))}
      />
      <MachineFilter
        value={controls.machine}
        onChange={controls.setMachine}
        options={[{ value: "all", label: "All machines" }, ...controls.machines.map((item) => ({ value: item.id, label: item.name }))]}
      />
      <button
        type="button"
        onClick={controls.sync}
        disabled={controls.syncing}
        aria-label="Sync usage now"
        title={controls.lastSyncedAt ? `Last synced ${new Date(controls.lastSyncedAt).toLocaleString()}` : "Sync usage now"}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 text-muted-foreground transition-[background-color,color,transform] duration-150 ease-out hover:bg-muted/50 hover:text-foreground active:scale-[0.96] disabled:cursor-wait disabled:opacity-50"
      >
        <Icon name="RotateCcw" className={`size-4 ${controls.syncing ? "animate-spin" : ""}`} aria-hidden="true" />
      </button>
    </div>
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
  const containerRef = useRef<HTMLDivElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState(980);
  const width = Math.max(360, measuredWidth);
  const height = 322;
  const inset = { top: 14, right: 8, bottom: 32, left: 62 };
  const days = useMemo(() => rangeDays(range), [range]);
  const totalsByKey = new Map<string, number>();

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const updateWidth = () => setMeasuredWidth(element.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

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
    <div ref={containerRef} className="overflow-x-auto">
      <svg width={width} height={height} className="block min-w-[360px]" role="img" aria-label={`Daily ${mode} by provider`}>
        <defs>
          {providers.map((provider) => (
            <linearGradient key={provider.id} id={`usage-area-${provider.id}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={providerColor(provider.id)} stopOpacity="0.16" />
              <stop offset="100%" stopColor={providerColor(provider.id)} stopOpacity="0" />
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
          {series.map((item) => {
            const points = item.values.map((value, index) => ({ x: x(index), y: y(value) }));
            const line = smoothPath(points, inset.top, inset.top + chartHeight);
            const area = `${line} L ${x(days.length - 1)} ${y(0)} L ${x(0)} ${y(0)} Z`;
            return (
              <g key={item.id}>
                <path d={area} fill={`url(#usage-area-${item.id})`} />
                <path
                  d={line}
                  fill="none"
                  stroke={providerColor(item.id)}
                  strokeWidth="2.5"
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
  const [machine, setMachine] = useState("all");
  const [chartMode, setChartMode] = useState<ChartMode>("cost");
  const [breakdownMode, setBreakdownMode] = useState<BreakdownMode>("model");
  const [breakdownPage, setBreakdownPage] = useState(1);
  const [syncing, setSyncing] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const [contentWidth, setContentWidth] = useState(0);

  const load = useCallback(() => {
    setError(null);
    void rpc.call("dashboard").then(setData).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [rpc]);

  const sync = useCallback(() => {
    setSyncing(true);
    setError(null);
    void rpc.call("sync")
      .then(() => rpc.call("dashboard"))
      .then(setData)
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setSyncing(false));
  }, [rpc]);

  useEffect(load, [load]);
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
      && (machine === "all" || row.machineId === machine));
  }, [data, machine, range]);

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

  const days = useMemo(() => rangeDays(range), [range]);

  useEffect(() => {
    if (!data) return;
    publishHeaderControls({
      machine,
      range,
      machines: data.machines,
      dateLabel: `${formatDay(days[0])}–${formatDay(days[days.length - 1])}`,
      syncing,
      lastSyncedAt: data.lastSyncedAt,
      setMachine,
      setRange,
      sync,
    });
  }, [data, days, machine, range, sync, syncing]);

  useEffect(() => () => publishHeaderControls(null), []);

  useEffect(() => setBreakdownPage(1), [breakdownMode, machine, range]);

  useEffect(() => {
    const element = mainRef.current;
    if (!element || !data) return;
    const updateWidth = () => setContentWidth(element.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, [data]);

  if (error) {
    return <div className="flex h-full items-center justify-center p-8 text-sm text-destructive">Could not load usage: {error}</div>;
  }
  if (!data) {
    return <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">Loading usage…</div>;
  }

  const activeProviders = data.providers;
  const providerTotals = activeProviders.map((item) => ({
    ...item,
    cost: rows.filter((row) => row.providerId === item.id).reduce((sum, row) => sum + row.costUsd, 0),
    tokens: rows.filter((row) => row.providerId === item.id).reduce((sum, row) => sum + row.processedTokens, 0),
  }));
  const visibleSources = data.sources.filter((source) => machine === "all" || source.machineId === machine);
  const sourceIssues = visibleSources.filter((source) => !["ready", "no-data"].includes(source.status));
  const breakdown = breakdownMode === "model" ? modelBreakdown : dayBreakdown;
  const paginatedBreakdown = paginateItems(breakdown, breakdownPage, BREAKDOWN_PAGE_SIZE);
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
      <main
        ref={mainRef}
        className="mx-auto w-full max-w-[1440px] px-4 py-4 md:px-5 md:py-5 lg:px-6"
        style={{ boxSizing: "border-box", width: "100%", maxWidth: 1440, margin: "0 auto", padding: "20px 24px" }}
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-border/70 pb-4 md:hidden">
          <ToggleGroup
            value={range}
            onChange={setRange}
            label={`Date range, ${formatDay(days[0])}–${formatDay(days[days.length - 1])}`}
            options={[7, 30, 90].map((value) => ({ value: value as Range, label: `${value} days` }))}
          />
          <MachineFilter
            value={machine}
            onChange={setMachine}
            options={[{ value: "all", label: "All machines" }, ...data.machines.map((item) => ({ value: item.id, label: item.name }))]}
          />
          <button
            type="button"
            onClick={sync}
            disabled={syncing}
            aria-label="Sync usage now"
            title={data.lastSyncedAt ? `Last synced ${new Date(data.lastSyncedAt).toLocaleString()}` : "Sync usage now"}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 text-muted-foreground transition-[background-color,color,transform] duration-150 ease-out hover:bg-muted/50 hover:text-foreground active:scale-[0.96] disabled:cursor-wait disabled:opacity-50"
          >
            <Icon name="RotateCcw" className={`size-4 ${syncing ? "animate-spin" : ""}`} aria-hidden="true" />
          </button>
        </div>

        {sourceIssues.length > 0 && (
          <div className="mt-4 flex min-h-9 items-center gap-2.5 rounded-md border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-xs leading-5 text-muted-foreground">
            <Icon name="AlertTriangle" className="size-4 shrink-0 text-amber-500/90" aria-hidden="true" />
            <span><span className="font-medium text-foreground/80">Some usage history is unavailable.</span> {sourceIssues.length} source{sourceIssues.length === 1 ? "" : "s"} reported partial data; available records are included.</span>
          </div>
        )}

        {rows.length === 0 ? (
          <div className="flex min-h-[420px] flex-col items-center justify-center border-b border-border text-center">
            <div className="text-sm font-medium">No usage in this view</div>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">Try a wider date range, another filter, or sync connected machines.</p>
          </div>
        ) : (
          <>
            <section
              className="grid gap-8 py-6 min-[900px]:grid-cols-[minmax(250px,0.72fr)_minmax(0,1.8fr)] min-[900px]:items-start lg:gap-10"
              style={{
                display: "grid",
                gridTemplateColumns: contentWidth >= 900 ? "minmax(250px, 0.72fr) minmax(0, 1.8fr)" : "minmax(0, 1fr)",
                alignItems: "start",
                gap: contentWidth >= 1024 ? 40 : 32,
                padding: "24px 0",
              }}
            >
              <div className="pt-1">
                <div className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">Raw token cost</div>
                <div
                  className="mt-2 text-4xl font-semibold tracking-tight tabular-nums md:text-[42px]"
                  style={{ marginTop: 8, fontSize: 42, lineHeight: "46px", fontWeight: 600, letterSpacing: "-0.025em" }}
                >
                  {money(totals.cost)}*
                </div>
                <div className="mt-1 text-sm text-muted-foreground">If billed at standard API rates</div>

                <div className="mt-6 space-y-5">
                  {providerTotals.map((item) => (
                    <div key={item.id}>
                      <div className="flex items-center justify-between gap-4 text-sm">
                        <span className="flex min-w-0 items-center gap-2 font-medium">
                          <span className="size-2 rounded-full" style={{ backgroundColor: providerColor(item.id) }} />
                          <span className="truncate">{item.name}</span>
                        </span>
                        <span className="tabular-nums">{money(item.cost)}</span>
                      </div>
                      <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${totals.cost ? (item.cost / totals.cost) * 100 : 0}%`,
                            backgroundColor: providerColor(item.id),
                          }}
                        />
                      </div>
                      <div className="mt-2 text-xs text-muted-foreground">{percentage(item.cost, totals.cost)} of cost · {compact(item.tokens)} tokens</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="min-w-0" style={{ minWidth: 0 }}>
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 min-[1200px]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
                  <h2 className="text-sm font-semibold">Daily {chartMode === "cost" ? "cost" : "tokens"}</h2>
                  <div className="justify-self-end min-[1200px]:col-start-3">
                    <ToggleGroup
                      value={chartMode}
                      onChange={setChartMode}
                      label="Chart value"
                      options={[{ value: "cost", label: "Cost" }, { value: "tokens", label: "Tokens" }]}
                    />
                  </div>
                  <div className="col-span-2 row-start-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground min-[1200px]:col-span-1 min-[1200px]:col-start-2 min-[1200px]:row-start-1" aria-label="Usage providers">
                    {activeProviders.map((item) => (
                      <span key={item.id} className="flex items-center gap-1.5 whitespace-nowrap">
                        <span className="size-2 rounded-full" style={{ backgroundColor: providerColor(item.id) }} aria-hidden="true" />
                        {item.name}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="mt-4">
                  <UsageChart records={rows} providers={activeProviders} range={range} mode={chartMode} />
                </div>
              </div>
            </section>

            <section className="overflow-x-auto border-y border-border">
              <div
                className="grid min-w-[800px] grid-cols-5 divide-x divide-border"
                style={{ display: "grid", minWidth: 800, gridTemplateColumns: "repeat(5, minmax(0, 1fr))" }}
              >
                {metrics.map((metric) => (
                  <div
                    key={metric.label}
                    className="min-w-0 px-4 py-5 first:pl-0 last:pr-0 md:px-5"
                    style={{ boxSizing: "border-box", minWidth: 0, padding: "20px" }}
                  >
                    <div className="text-sm text-muted-foreground" style={{ fontSize: 13, lineHeight: "20px" }}>{metric.label}</div>
                    <div className="mt-1 text-2xl font-medium tabular-nums" style={{ marginTop: 4, fontSize: 24, lineHeight: "32px", fontWeight: 500 }}>{metric.value}</div>
                    <div className="mt-1 text-sm leading-5 text-muted-foreground" style={{ marginTop: 4, fontSize: 13, lineHeight: "20px" }}>{metric.detail}</div>
                  </div>
                ))}
              </div>
            </section>

            <section className="py-6">
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-base font-semibold">Breakdown</h2>
                <ToggleGroup
                  value={breakdownMode}
                  onChange={setBreakdownMode}
                  label="Breakdown grouping"
                  options={[{ value: "model", label: "Model" }, { value: "day", label: "Day" }]}
                />
              </div>

              <div className="mt-3 overflow-x-auto">
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
                    {paginatedBreakdown.items.map((row) => (
                      <tr key={row.key} className="border-b border-border/60 transition-colors duration-150 hover:bg-muted/20 last:border-0">
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

              {breakdown.length > BREAKDOWN_PAGE_SIZE && (
                <div className="mt-3 flex items-center justify-end gap-2 text-xs tabular-nums text-muted-foreground">
                  <span>{paginatedBreakdown.rangeStart}–{paginatedBreakdown.rangeEnd} of {paginatedBreakdown.totalItems}</span>
                  <button
                    type="button"
                    aria-label="Previous breakdown page"
                    title="Previous page"
                    disabled={!paginatedBreakdown.canPrevious}
                    onClick={() => setBreakdownPage(paginatedBreakdown.page - 1)}
                    className="inline-flex size-7 items-center justify-center rounded-md border border-border/70 transition-[background-color,color,transform] duration-150 ease-out hover:bg-muted/50 hover:text-foreground active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40"
                  >
                    <Icon name="ChevronLeft" className="size-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label="Next breakdown page"
                    title="Next page"
                    disabled={!paginatedBreakdown.canNext}
                    onClick={() => setBreakdownPage(paginatedBreakdown.page + 1)}
                    className="inline-flex size-7 items-center justify-center rounded-md border border-border/70 transition-[background-color,color,transform] duration-150 ease-out hover:bg-muted/50 hover:text-foreground active:scale-[0.96] disabled:pointer-events-none disabled:opacity-40"
                  >
                    <Icon name="ChevronRight" className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
              )}
            </section>
          </>
        )}

        <footer className="border-t border-border/70 pb-2 pt-4 text-xs text-muted-foreground">
          {data.notice} Price sheet {data.pricingVersion}.
        </footer>
      </main>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "usage",
    title: "Usage",
    icon: "ChartColumn",
    path: "usage",
    component: UsageDashboard,
    headerContent: UsageHeaderControls,
  });
});
