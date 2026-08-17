import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { definePluginApp, useRealtime, useRealtimeConnectionState, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Icon } from "@/components/ui/icon";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useMediaQuery } from "@/components/ui/hooks/use-media-query";
import { UsageDashboardSkeleton } from "@/components/usage-dashboard-skeleton";
import { paginateItems } from "@/lib/pagination";
import type { UsageSyncSnapshot } from "@/lib/sync-coordinator";
import { isUsageSyncInProgress, shouldPollUsage, shouldShowInitialUsageLoading, usageRefreshError } from "@/lib/usage-sync-state";
import { getEmptyUsageView, getSourceIssueMessage } from "@/lib/usage-view-state";
import { clampPercent, formatLimitReset, formatLimitValue, type ProviderLimitWindow } from "@/lib/provider-limits";

type Range = 7 | 30 | 90;
type ChartMode = "cost" | "tokens";
type BreakdownMode = "model" | "day";
type DimensionMode = "agent" | "provider";

const BREAKDOWN_PAGE_SIZE = 10;
const SHOW_USAGE_LIMITS_STORAGE_KEY = "bb-plugin-usage:show-usage-limits";

type UsageToolbarState = {
  range: Range;
  machine: string;
  showUsageLimits: boolean;
  machines: DashboardData["machines"];
  lastSyncedAt: string | null;
  syncing: boolean;
};

let usageToolbarState: UsageToolbarState = {
  range: 7,
  machine: "all",
  showUsageLimits: false,
  machines: [],
  lastSyncedAt: null,
  syncing: false,
};
let usageToolbarSync: (() => void) | null = null;
const usageToolbarListeners = new Set<() => void>();

function updateUsageToolbar(next: Partial<UsageToolbarState>) {
  usageToolbarState = { ...usageToolbarState, ...next };
  usageToolbarListeners.forEach((listener) => listener());
}

function useUsageToolbar() {
  return useSyncExternalStore(
    (listener) => {
      usageToolbarListeners.add(listener);
      return () => usageToolbarListeners.delete(listener);
    },
    () => usageToolbarState,
    () => usageToolbarState,
  );
}

function rememberShowUsageLimits(checked: boolean) {
  updateUsageToolbar({ showUsageLimits: checked });
  try {
    window.localStorage.setItem(SHOW_USAGE_LIMITS_STORAGE_KEY, checked ? "true" : "false");
  } catch {
    // The preference remains active for this session when storage is unavailable.
  }
}

type UsageRecord = {
  day: string;
  agentId: string;
  agentName: string;
  modelProviderId: string;
  modelProviderName: string;
  machineId: string;
  machineName: string;
  model: string;
  costUsd: number;
  loggedCostUsd: number | null;
  pricingStatus: string;
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
  agents: Array<{ id: string; name: string; status?: string }>;
  modelProviders: Array<{ id: string; name: string; status?: string }>;
  records: UsageRecord[];
  sources: Array<{
    machineId: string;
    agentId: string;
    status: string;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    recordCount: number;
    error: string | null;
  }>;
  providerLimits: Array<{
    machineId: string;
    machineName: string;
    providerId: string;
    providerName: string;
    planLabel: string | null;
    windows: ProviderLimitWindow[];
  }>;
  sync: UsageSyncSnapshot;
  notice: string;
};

const PROVIDER_COLORS: Record<string, string> = {
  codex: "#10A37F",
  claude: "#D97757",
  grok: "#6E7CF6",
  opencode: "#0EA5E9",
  pi: "#F59E0B",
  openai: "#10A37F",
  anthropic: "#D97757",
  xai: "#6E7CF6",
  google: "#4285F4",
  openrouter: "#8B5CF6",
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
  fill = false,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  label: string;
  fill?: boolean;
}) {
  return (
    <div
      className={`${fill ? "flex w-full" : "inline-flex"} h-8 items-center rounded-md border border-border/70 bg-muted/30 p-0.5`}
      role="group"
      aria-label={label}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`inline-flex h-6 items-center justify-center rounded-[5px] px-2.5 text-xs font-medium leading-none transition-[background-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.97] ${fill ? "flex-1" : ""} ${
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
  fill = false,
  width = 180,
  contentWidth,
  ariaLabel = "Filter usage by machine",
  triggerLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  fill?: boolean;
  width?: number;
  contentWidth?: number;
  ariaLabel?: string;
  triggerLabel?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        aria-label={ariaLabel}
        className="h-8 border-border/70 bg-muted/20 px-2.5 py-0 text-xs font-medium shadow-none hover:bg-muted/40 focus:ring-1 data-[state=open]:bg-muted/40 [&>svg]:size-3.5 [&>svg]:opacity-60"
        style={{ width: fill ? "100%" : width }}
      >
        <SelectValue>{triggerLabel}</SelectValue>
      </SelectTrigger>
      <SelectContent
        align="end"
        sideOffset={4}
        className="[&_[role=option]>span:last-child]:truncate"
        style={{
          width: contentWidth ?? "var(--radix-select-trigger-width)",
          minWidth: contentWidth ?? "var(--radix-select-trigger-width)",
        }}
      >
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} className="whitespace-nowrap text-xs">
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function UsageChart({
  records,
  providers,
  range,
  mode,
  groupBy,
  compactView = false,
}: {
  records: UsageRecord[];
  providers: Array<{ id: string; name: string }>;
  range: Range;
  mode: ChartMode;
  groupBy: DimensionMode;
  compactView?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState(980);
  const width = Math.max(compactView ? 240 : 360, measuredWidth);
  const height = compactView ? 250 : 322;
  const inset = compactView
    ? { top: 12, right: 4, bottom: 30, left: 48 }
    : { top: 14, right: 8, bottom: 32, left: 62 };
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
    const dimensionId = groupBy === "agent" ? record.agentId : record.modelProviderId;
    const key = `${record.day}:${dimensionId}`;
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
    <div ref={containerRef} className="min-w-0 overflow-hidden">
      <svg width={width} height={height} className="block max-w-full" role="img" aria-label={`Daily ${mode} by ${groupBy}`}>
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

function ProviderLimits({
  limits,
  contentWidth,
}: {
  limits: DashboardData["providerLimits"];
  contentWidth: number;
}) {
  const machineMap = new Map<string, DashboardData["providerLimits"]>();
  for (const limit of limits) {
    const providers = machineMap.get(limit.machineId) ?? [];
    providers.push(limit);
    machineMap.set(limit.machineId, providers);
  }
  const machines = Array.from(machineMap, ([machineId, providers]) => ({
    machineId,
    machineName: providers[0]?.machineName ?? "Unknown machine",
    providers,
  }));
  const columnCount = contentWidth < 640 ? 1 : contentWidth < 1080 ? 2 : 3;
  const constrainHeight = contentWidth >= 1024;

  return (
    <section className="mt-3 rounded-lg border border-border/70 bg-muted/[0.08] px-3 py-2.5" aria-labelledby="provider-limits-title">
      <div className="flex items-baseline justify-between gap-3 px-0.5">
        <h2 id="provider-limits-title" className="text-sm font-medium">Usage limits</h2>
        <span className="text-xs text-muted-foreground">Current plan windows</span>
      </div>
      {machines.length === 0 ? (
        <p className="mt-2 px-0.5 text-xs text-muted-foreground">No provider limits are available from connected machines.</p>
      ) : (
        <div
          className={`mt-4 grid gap-2 ${constrainHeight ? "max-h-60 overflow-y-auto pr-1" : ""}`}
          style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}
        >
          {machines.map((machine) => (
            <div
              key={machine.machineId}
              className="min-w-0 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2"
            >
              <div className="truncate text-[11px] font-medium text-muted-foreground" title={machine.machineName}>
                {machine.machineName}
              </div>
              <div className="mt-1 divide-y divide-border/50 border-t border-border/50">
                {machine.providers.map((limit) => (
                  <div key={limit.providerId} className="py-2 first:pt-1.5 last:pb-0">
                    <div className="flex min-w-0 items-baseline justify-between gap-3">
                      <div className="min-w-0 truncate text-xs font-medium">{limit.providerName}</div>
                      {limit.planLabel && <div className="max-w-[45%] shrink-0 truncate text-[10px] text-muted-foreground" title={limit.planLabel}>{limit.planLabel}</div>}
                    </div>
                    <div className="mt-1.5 space-y-1.5">
                      {limit.windows.map((window, index) => {
                        const reset = formatLimitReset(window.resetsAt);
                        const usedPercent = clampPercent(window.usedPercent);
                        return (
                          <div key={`${window.label}:${index}`}>
                            <div className="flex items-center justify-between gap-3 text-[10px] leading-4">
                              <span className="truncate text-muted-foreground">{window.label}{reset ? ` · ${reset}` : ""}</span>
                              <span className="shrink-0 tabular-nums text-foreground/80">{formatLimitValue(window)}</span>
                            </div>
                            <div
                              className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"
                              role="progressbar"
                              aria-label={`${machine.machineName} ${limit.providerName} ${window.label}`}
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={Math.round(usedPercent)}
                            >
                              <div
                                className="h-full rounded-full"
                                style={{
                                  width: `${usedPercent}%`,
                                  backgroundColor: usedPercent >= 90 ? "var(--destructive)" : providerColor(limit.providerId),
                                }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function UsageToolbarControls({ placement }: { placement: "header" | "body" }) {
  const toolbar = useUsageToolbar();
  const phoneToolbar = useMediaQuery("(max-width: 479px)");
  const inBody = placement === "body";
  const selectedMachineLabel = toolbar.machine === "all"
    ? "All machines"
    : toolbar.machines.find((item) => item.id === toolbar.machine)?.name;

  return (
    <div className={inBody
      ? "flex w-full flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-muted/[0.12] p-2"
      : "flex min-w-0 items-center gap-2"}
    >
      {!inBody && (
        <label className="flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground">
          <Checkbox
            checked={toolbar.showUsageLimits}
            onCheckedChange={(checked) => rememberShowUsageLimits(checked === true)}
            aria-label="Show usage limits"
          />
          <span>Show usage limits</span>
        </label>
      )}
      <MachineFilter
        value={String(toolbar.range)}
        onChange={(value) => updateUsageToolbar({ range: Number(value) as Range })}
        ariaLabel="Usage duration"
        width={inBody ? (phoneToolbar ? 96 : 110) : 118}
        contentWidth={148}
        triggerLabel={`Last ${toolbar.range} days`}
        options={[7, 30, 90].map((value) => ({ value: String(value), label: `Last ${value} days` }))}
      />
      <div className={inBody ? "min-w-[120px] flex-1" : undefined}>
        <MachineFilter
          value={toolbar.machine}
          onChange={(machine) => updateUsageToolbar({ machine })}
          ariaLabel="Filter usage by machine"
          width={160}
          fill={inBody}
          triggerLabel={selectedMachineLabel}
          options={[{ value: "all", label: "All machines" }, ...toolbar.machines.map((item) => ({ value: item.id, label: item.name }))]}
        />
      </div>
      {inBody && (
        <label className={`flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground ${phoneToolbar ? "w-full" : ""}`}>
          <Checkbox
            checked={toolbar.showUsageLimits}
            onCheckedChange={(checked) => rememberShowUsageLimits(checked === true)}
            aria-label="Show usage limits"
          />
          <span>Show usage limits</span>
        </label>
      )}
      {!inBody && <UsageSyncButton />}
    </div>
  );
}

function UsageSyncButton() {
  const toolbar = useUsageToolbar();

  return (
    <button
      type="button"
      onClick={() => usageToolbarSync?.()}
      disabled={toolbar.syncing || !usageToolbarSync}
      aria-label="Sync usage now"
      title={toolbar.lastSyncedAt ? `Last synced ${new Date(toolbar.lastSyncedAt).toLocaleString()}` : "Sync usage now"}
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 text-muted-foreground transition-[background-color,color,transform] duration-150 ease-out hover:bg-muted/50 hover:text-foreground active:scale-[0.96] disabled:cursor-wait disabled:opacity-50"
    >
      <Icon name="RotateCcw" className={`size-4 ${toolbar.syncing ? "animate-spin" : ""}`} aria-hidden="true" />
    </button>
  );
}

function UsageHeaderControls() {
  const compactHeader = useMediaQuery("(max-width: 1023px)");

  useEffect(() => {
    try {
      updateUsageToolbar({ showUsageLimits: window.localStorage.getItem(SHOW_USAGE_LIMITS_STORAGE_KEY) === "true" });
    } catch {
      // Keep the default unchecked state when storage is unavailable.
    }
  }, []);

  if (compactHeader) return <UsageSyncButton />;
  return <UsageToolbarControls placement="header" />;
}

function UsageResponsiveControls() {
  const compactHeader = useMediaQuery("(max-width: 1023px)");
  if (!compactHeader) return null;
  return <UsageToolbarControls placement="body" />;
}

function UsageDashboard() {
  const rpc = useRpc<typeof rpcContract>();
  const realtimeState = useRealtimeConnectionState();
  const hasConnected = useRef(false);
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { range, machine, showUsageLimits } = useUsageToolbar();
  const [chartGroup, setChartGroup] = useState<DimensionMode>("agent");
  const [costGroup, setCostGroup] = useState<DimensionMode>("agent");
  const [chartMode, setChartMode] = useState<ChartMode>("cost");
  const [breakdownMode, setBreakdownMode] = useState<BreakdownMode>("model");
  const [breakdownPage, setBreakdownPage] = useState(1);
  const [syncRequested, setSyncRequested] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const [contentWidth, setContentWidth] = useState(0);
  const compactView = contentWidth < 640;
  const stackedView = contentWidth < 900;
  const syncing = syncRequested || (data ? isUsageSyncInProgress(data.sync) : false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const nextData = await rpc.call("dashboard");
      setData(nextData);
      if (!isUsageSyncInProgress(nextData.sync)) setSyncRequested(false);
    } catch (reason) {
      setSyncRequested(false);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [rpc]);

  const sync = useCallback(() => {
    setSyncRequested(true);
    setError(null);
    void rpc.call("sync")
      .then(() => load())
      .catch((reason) => {
        setSyncRequested(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, [load, rpc]);

  useEffect(() => {
    usageToolbarSync = sync;
    return () => {
      if (usageToolbarSync === sync) usageToolbarSync = null;
    };
  }, [sync]);

  useEffect(() => {
    updateUsageToolbar({
      machines: data?.machines ?? [],
      lastSyncedAt: data?.lastSyncedAt ?? null,
      syncing,
    });
  }, [data, syncing]);

  useEffect(() => {
    if (machine !== "all" && data && !data.machines.some((item) => item.id === machine)) {
      updateUsageToolbar({ machine: "all" });
    }
  }, [data, machine]);

  useEffect(() => { void load(); }, [load]);
  useRealtime("usage-updated", () => { void load(); });
  useEffect(() => {
    if (realtimeState !== "connected") return;
    if (hasConnected.current) void load();
    else hasConnected.current = true;
  }, [load, realtimeState]);

  useEffect(() => {
    if (!data || !shouldPollUsage(data.sync)) return;
    const timer = window.setTimeout(() => { void load(); }, 750);
    return () => window.clearTimeout(timer);
  }, [data, load]);

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

  type BreakdownRow = { key: string; label: string; agent: string; agentId: string; provider: string; providerId: string; cost: number; tokens: number };
  const modelBreakdown = useMemo(() => {
    const map = new Map<string, BreakdownRow>();
    for (const row of rows) {
      const key = `${row.agentId}:${row.modelProviderId}:${row.model}`;
      const current = map.get(key) ?? { key, label: row.model, agent: row.agentName, agentId: row.agentId, provider: row.modelProviderName, providerId: row.modelProviderId, cost: 0, tokens: 0 };
      current.cost += row.costUsd;
      current.tokens += row.processedTokens;
      map.set(key, current);
    }
    return [...map.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
  }, [rows]);

  const dayBreakdown = useMemo(() => {
    const map = new Map<string, BreakdownRow>();
    for (const row of rows) {
      const current = map.get(row.day) ?? { key: row.day, label: formatDay(row.day, true), agent: "All agents", agentId: "all", provider: "All providers", providerId: "all", cost: 0, tokens: 0 };
      current.cost += row.costUsd;
      current.tokens += row.processedTokens;
      map.set(row.day, current);
    }
    return [...map.values()].sort((a, b) => b.key.localeCompare(a.key));
  }, [rows]);

  const days = useMemo(() => rangeDays(range), [range]);

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

  if (error && !data) {
    return <div className="flex h-full items-center justify-center p-8 text-sm text-destructive">Could not load usage: {error}</div>;
  }
  if (!data || shouldShowInitialUsageLoading(data.sync)) {
    return <UsageDashboardSkeleton />;
  }
  if (data.sync.phase === "error" && data.sync.completedAt === null) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <div className="max-w-md">
          <div className="text-sm font-medium">Usage couldn’t be collected</div>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{data.sync.error ?? "The initial machine scan failed."}</p>
          <button
            type="button"
            onClick={sync}
            disabled={syncing}
            className="mt-4 inline-flex h-8 items-center justify-center gap-2 rounded-md border border-border px-3 text-sm font-medium transition-colors hover:bg-muted/50 disabled:pointer-events-none disabled:opacity-50"
          >
            <Icon name="RotateCcw" className={`size-4 ${syncing ? "animate-spin" : ""}`} aria-hidden="true" />
            Try again
          </button>
        </div>
      </div>
    );
  }

  const usedAgentIds = new Set(rows.map((row) => row.agentId));
  const usedProviderIds = new Set(rows.map((row) => row.modelProviderId));
  const activeAgents = data.agents.filter((item) => usedAgentIds.has(item.id));
  const activeModelProviders = data.modelProviders.filter((item) => usedProviderIds.has(item.id));
  const activeProviders = chartGroup === "agent" ? activeAgents : activeModelProviders;
  const costDimensions = costGroup === "agent" ? activeAgents : activeModelProviders;
  const providerTotals = costDimensions.map((item) => ({
    ...item,
    cost: rows.filter((row) => (costGroup === "agent" ? row.agentId : row.modelProviderId) === item.id).reduce((sum, row) => sum + row.costUsd, 0),
    tokens: rows.filter((row) => (costGroup === "agent" ? row.agentId : row.modelProviderId) === item.id).reduce((sum, row) => sum + row.processedTokens, 0),
  })).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
  const visibleMachines = data.machines.filter((item) => machine === "all" || item.id === machine);
  const visibleSources = data.sources.filter((source) => machine === "all" || source.machineId === machine);
  const sourceIssueMessage = getSourceIssueMessage(visibleMachines, visibleSources);
  const refreshError = usageRefreshError(data.sync, error);
  const dataWarning =
    refreshError
      ? {
          title: "Usage couldn’t be refreshed.",
          detail: `Showing the last available data${data.lastSyncedAt ? ` from ${new Date(data.lastSyncedAt).toLocaleString()}` : ""}. ${refreshError}${sourceIssueMessage && rows.length > 0 ? ` ${sourceIssueMessage}` : ""}`,
        }
      : sourceIssueMessage && rows.length > 0
        ? { title: "Some usage history is unavailable.", detail: sourceIssueMessage }
        : null;
  const emptyView = getEmptyUsageView({
    machines: visibleMachines,
    sources: visibleSources,
    hasRecordsOutsideView: data.records.some((record) => machine === "all" || record.machineId === machine),
  });
  const breakdown = breakdownMode === "model" ? modelBreakdown : dayBreakdown;
  const paginatedBreakdown = paginateItems(breakdown, breakdownPage, BREAKDOWN_PAGE_SIZE);
  const activeDays = new Set(rows.map((row) => row.day)).size;
  const visibleProviderLimits = data.providerLimits.filter((limit) => machine === "all" || limit.machineId === machine);

  const metrics = [
    { label: "Processed tokens", value: compact(totals.processed), detail: `${compact(totals.processed / Math.max(1, activeDays))} per active day` },
    { label: "Cached input", value: compact(totals.cached), detail: `${percentage(totals.cached, totals.cached + totals.uncached)} of input · ${compact(totals.cacheWrites)} writes` },
    { label: "Output", value: compact(totals.output), detail: "Includes reasoning tokens" },
    { label: "Cache savings", value: money(totals.cacheSavings), detail: totals.cost > 0 ? `${(totals.cacheSavings / totals.cost).toFixed(1)}× the raw token cost` : `Price sheet ${data.pricingVersion}` },
  ];

  return (
    <div className="h-full overflow-y-auto bg-background">
      <main
        ref={mainRef}
        className="mx-auto flex min-h-full w-full max-w-[1440px] flex-col px-4 py-4 md:px-5 md:py-5 lg:px-6"
        style={{
          boxSizing: "border-box",
          width: "100%",
          minHeight: "100%",
          maxWidth: 1440,
          margin: "0 auto",
          padding: compactView ? "16px" : "20px 24px",
        }}
      >
        <UsageResponsiveControls />

        {showUsageLimits && (
          <ProviderLimits limits={visibleProviderLimits} contentWidth={contentWidth} />
        )}

        {rows.length === 0 ? (
          <div
            className="flex flex-1 flex-col items-center justify-center text-center"
            style={{ minHeight: 280, padding: "clamp(52px, 10vh, 80px) 24px" }}
          >
            <div className={`flex size-10 items-center justify-center rounded-full ${emptyView.kind === "error" ? "bg-destructive/10 text-destructive" : emptyView.kind === "offline" ? "bg-amber-500/10 text-amber-500" : "bg-muted text-muted-foreground"}`}>
              <Icon
                name={emptyView.kind === "offline" ? "Laptop" : emptyView.kind === "error" ? "AlertCircle" : emptyView.kind === "filtered" ? "Calendar" : "File"}
                className="size-5"
                aria-hidden="true"
              />
            </div>
            <div className="mt-4 text-sm font-medium">{emptyView.title}</div>
            <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">{emptyView.description}</p>
          </div>
        ) : (
          <>
            <section
              className="grid py-6"
              style={{
                gridTemplateColumns: stackedView ? "minmax(0, 1fr)" : "minmax(330px, 0.92fr) minmax(0, 1.65fr)",
                alignItems: "stretch",
                gap: stackedView ? 20 : contentWidth >= 1024 ? 48 : 36,
              }}
            >
              <div
                className={`min-w-0 flex flex-col${stackedView ? "" : " relative"}`}
                style={stackedView ? {
                  border: "1px solid hsl(var(--border) / 0.7)",
                  borderRadius: 12,
                  background: "hsl(var(--muted) / 0.18)",
                  padding: compactView ? 20 : 24,
                } : undefined}
              >
                <div className={stackedView ? "flex min-w-0 flex-col" : "absolute inset-0 flex flex-col"}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">Raw token cost</span>
                    {dataWarning && (
                      <TooltipProvider>
                        <Tooltip delayDuration={150}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              aria-label="Usage data warning"
                              className="inline-flex size-5 -my-1 items-center justify-center rounded text-amber-500/90 transition-[background-color,color,transform] duration-150 ease-out hover:bg-muted/50 hover:text-amber-500 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            >
                              <Icon name="Info" className="size-3.5" aria-hidden="true" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <div className="font-medium text-foreground/90">{dataWarning.title}</div>
                            <div className="mt-0.5 text-muted-foreground">{dataWarning.detail}</div>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    )}
                  </div>
                  <ToggleGroup value={costGroup} onChange={setCostGroup} label="Cost breakdown" options={[{ value: "agent", label: "Agents" }, { value: "provider", label: "Providers" }]} />
                </div>
                <div
                  className="mt-2 font-semibold tracking-tight tabular-nums"
                  style={{
                    fontSize: compactView ? 36 : 42,
                    lineHeight: compactView ? "40px" : "46px",
                    letterSpacing: "-0.025em",
                  }}
                >
                  {money(totals.cost)}*
                </div>
                <div className="mt-1 text-sm text-muted-foreground">If billed at standard API rates</div>
                {!stackedView && (
                  <div className="space-y-5 overflow-y-auto pr-3 flex-1 min-h-0" style={{ marginTop: 28 }}>
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
                )}

                {stackedView && (
                  <div className="mt-7 min-w-0 border-t border-border/60 pt-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="mr-auto text-sm font-semibold">Daily {chartMode === "cost" ? "cost" : "tokens"}</h2>
                      <ToggleGroup
                        value={chartGroup}
                        onChange={setChartGroup}
                        label="Chart series"
                        options={[{ value: "agent", label: "Agents" }, { value: "provider", label: "Providers" }]}

                      />

                      <ToggleGroup
                        value={chartMode}
                        onChange={setChartMode}
                        label="Chart value"
                        options={[{ value: "cost", label: "Cost" }, { value: "tokens", label: "Tokens" }]}
                      />
                    </div>
                    <div className="mt-3">
                      <UsageChart records={rows} providers={activeProviders} range={range} mode={chartMode} groupBy={chartGroup} compactView={compactView} />
                    </div>
                    <div className="mt-1 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground" aria-label={`Usage ${chartGroup === "agent" ? "agents" : "model providers"}`}>
                      {activeProviders.map((item) => (
                        <span key={item.id} className="flex items-center gap-1.5 whitespace-nowrap">
                          <span className="size-2 rounded-full" style={{ backgroundColor: providerColor(item.id) }} aria-hidden="true" />
                          {item.name}
                        </span>
                      ))}
                    </div>
                  </div>
                  )}
                </div>
              </div>

              {!stackedView && (
                <div className="min-w-0 flex flex-col">
                  <div className="flex items-center justify-between gap-4">
                    <h2 className="mr-auto text-sm font-semibold">Daily {chartMode === "cost" ? "cost" : "tokens"}</h2>
                    <div className="flex flex-wrap items-center gap-2">
                      <ToggleGroup
                        value={chartGroup}
                        onChange={setChartGroup}
                        label="Chart series"
                        options={[{ value: "agent", label: "Agents" }, { value: "provider", label: "Providers" }]}

                      />

                      <ToggleGroup
                        value={chartMode}
                        onChange={setChartMode}
                        label="Chart value"
                        options={[{ value: "cost", label: "Cost" }, { value: "tokens", label: "Tokens" }]}
                      />
                    </div>
                  </div>
                  <div className="mt-4">
                    <UsageChart records={rows} providers={activeProviders} range={range} mode={chartMode} groupBy={chartGroup} />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground" aria-label={`Usage ${chartGroup === "agent" ? "agents" : "model providers"}`}>
                    {activeProviders.map((item) => (
                      <span key={item.id} className="flex items-center gap-1.5 whitespace-nowrap">
                        <span className="size-2 rounded-full" style={{ backgroundColor: providerColor(item.id) }} aria-hidden="true" />
                        {item.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {stackedView && (
                <div>
                  <h2 className="mb-3 text-sm font-medium text-muted-foreground">{costGroup === "agent" ? "Agents" : "Model providers"}</h2>
                  <div className="overflow-hidden rounded-xl border border-border/70 bg-muted/[0.12]">
                    {providerTotals.map((item, index) => (
                      <div key={item.id} className={index === 0 ? "p-4" : "border-t border-border/60 p-4"}>
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
              )}
            </section>

            <section className={stackedView ? "pb-2" : "overflow-x-auto border-y border-border"}>
              {stackedView && <h2 className="mb-3 text-sm font-medium text-muted-foreground">Totals</h2>}
              <div
                className={stackedView ? "grid overflow-hidden rounded-xl border border-border/70 bg-muted/[0.12]" : "grid min-w-[720px] grid-cols-4 divide-x divide-border"}
                style={{
                  minWidth: stackedView ? 0 : 720,
                  gridTemplateColumns: stackedView
                    ? `repeat(${compactView ? 1 : 2}, minmax(0, 1fr))`
                    : "repeat(4, minmax(0, 1fr))",
                }}
              >
                {metrics.map((metric, index) => {
                  const columnCount = compactView ? 1 : 2;
                  return (
                    <div
                      key={metric.label}
                      className="min-w-0"
                      style={{
                        padding: compactView ? 16 : 20,
                        borderLeft: stackedView && index % columnCount !== 0
                          ? "1px solid hsl(var(--border) / 0.6)"
                          : undefined,
                        borderTop: stackedView && index >= columnCount
                          ? "1px solid hsl(var(--border) / 0.6)"
                          : undefined,
                      }}
                    >
                      <div className="text-sm text-muted-foreground" style={{ fontSize: 13, lineHeight: "20px" }}>{metric.label}</div>
                      <div className="mt-1 text-2xl font-medium tabular-nums" style={{ fontSize: 24, lineHeight: "32px" }}>{metric.value}</div>
                      <div className="mt-1 text-sm leading-5 text-muted-foreground" style={{ fontSize: 13, lineHeight: "20px" }}>{metric.detail}</div>
                    </div>
                  );
                })}
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

              {compactView ? (
                <div className="mt-3 overflow-hidden rounded-xl border border-border/70">
                  {paginatedBreakdown.items.map((row, index) => (
                    <div key={row.key} className={index === 0 ? "p-4" : "border-t border-border/60 p-4"}>
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{row.label}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{row.agent} · {row.provider}</div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-sm tabular-nums">{money(row.cost)}</div>
                          <div className="mt-1 text-xs tabular-nums text-muted-foreground">{percentage(row.cost, totals.cost)}</div>
                        </div>
                      </div>
                      <div className="mt-3 text-xs tabular-nums text-muted-foreground">{compact(row.tokens)} tokens</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[900px] border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-border text-xs text-muted-foreground">
                        <th className="pb-3 text-left font-normal">{breakdownMode === "model" ? "Model" : "Day"}</th>
                        <th className="pb-3 text-left font-normal">Agent</th>
                        <th className="pb-3 text-left font-normal">Model provider</th>
                        <th className="pb-3 text-right font-normal">Cost</th>
                        <th className="pb-3 text-right font-normal">Share</th>
                        <th className="pb-3 text-right font-normal">Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedBreakdown.items.map((row) => (
                        <tr key={row.key} className="border-b border-border/60 transition-colors duration-150 hover:bg-muted/20 last:border-0">
                          <td className="py-3 font-medium">{row.label}</td>
                          <td className="py-3 text-muted-foreground">{row.agent}</td>
                          <td className="py-3 text-muted-foreground">{row.provider}</td>
                          <td className="py-3 text-right tabular-nums">{money(row.cost)}</td>
                          <td className="py-3 text-right tabular-nums text-muted-foreground">{percentage(row.cost, totals.cost)}</td>
                          <td className="py-3 text-right tabular-nums text-muted-foreground">{compact(row.tokens)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

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

        <footer className={`flex flex-wrap items-center gap-x-6 gap-y-2 pb-1 text-xs text-muted-foreground ${rows.length > 0 ? "border-t border-border/70 pt-4" : "pt-2"}`}>
          {rows.length > 0 && <span className="min-w-0 flex-1">{data.notice} Price sheet {data.pricingVersion}.</span>}
          <a
            href="https://github.com/MayankBansal12/bb-plugin-usage/issues"
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 font-medium transition-[background-color,color,transform] duration-150 ease-out hover:bg-muted/50 hover:text-foreground active:scale-[0.97]"
          >
            Report issue or request feature
            <Icon name="ExternalLink" className="size-3.5" aria-hidden="true" />
          </a>
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
