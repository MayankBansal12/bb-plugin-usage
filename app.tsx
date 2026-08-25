import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { definePluginApp, useRealtime, useRealtimeConnectionState, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Icon } from "@/components/ui/icon";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ToggleGroup } from "@/components/ui/toggle-group";
import { useMediaQuery } from "@/components/ui/hooks/use-media-query";
import { UsageDashboardSkeleton } from "@/components/usage-dashboard-skeleton";
import { ProviderLogo, BRAND_COLORS, modelLogoId } from "@/components/provider-logo";
import { paginateItems } from "@/lib/pagination";
import type { UsageSyncSnapshot } from "@/lib/sync-coordinator";
import { isUsageSyncInProgress, shouldPollUsage, shouldShowInitialUsageLoading, usageRefreshError } from "@/lib/usage-sync-state";
import { getEmptyUsageView, getSourceIssueMessage } from "@/lib/usage-view-state";
import { clampPercent, formatLimitReset, formatLimitValue, type ProviderLimitWindow } from "@/lib/provider-limits";
import { formatLocalMoney, localCurrency, usdToLocalRate } from "@/lib/local-currency";

type Range = 7 | 30 | 90;
type ChartMode = "cost" | "tokens";
type BreakdownMode = "model" | "project" | "day";
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
  project: string;
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
    status: "ok" | "error";
    error: string | null;
  }>;
  sync: UsageSyncSnapshot;
  notice: string;
};

const FALLBACK_PROVIDER_COLORS = ["#0EA5E9", "#F59E0B", "#EC4899", "#14B8A6"];

function providerColor(providerId: string) {
  const normalizedId = providerId.toLowerCase();
  if (BRAND_COLORS[normalizedId]) return BRAND_COLORS[normalizedId];
  let hash = 0;
  for (const character of normalizedId) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return FALLBACK_PROVIDER_COLORS[Math.abs(hash) % FALLBACK_PROVIDER_COLORS.length];
}

function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function compact(value: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function percentage(value: number, total: number) {
  return total > 0 ? `${((value / total) * 100).toFixed(1)}%` : "0.0%";
}

// Renders a USD cost with a hover tooltip showing the equivalent in the
// browser's local currency. Falls back to plain USD when no rate is available.
function CostValue({ value, className }: { value: number; className?: string }) {
  const [localLabel, setLocalLabel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLocalLabel(null);
    void (async () => {
      const info = localCurrency();
      const rate = await usdToLocalRate(info.currency);
      if (!cancelled && rate !== null) setLocalLabel(formatLocalMoney(value, info, rate));
    })();
    return () => {
      cancelled = true;
    };
  }, [value]);

  if (!localLabel) return <span className={className}>{money(value)}</span>;
  return (
    <TooltipProvider>
      <Tooltip delayDuration={150}>
        <TooltipTrigger asChild>
          <span className={className}>{money(value)}</span>
        </TooltipTrigger>
        <TooltipContent side="top">
          ≈ {localLabel} ({localCurrency().currency})
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
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
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Array.from({ length: range }, (_, index) => {
    const day = new Date(end);
    day.setDate(end.getDate() - range + index + 1);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
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
        className="h-8 border-border/70 bg-muted/20 px-2.5 py-0 text-xs font-medium shadow-none hover:bg-muted/40 data-[state=open]:bg-muted/40 [&>svg]:size-3.5 [&>svg]:opacity-60"
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

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const width = 100;
  const height = 32;
  const gradientId = useRef(`spark-${Math.random().toString(36).slice(2)}`);
  const maximum = Math.max(1e-9, ...values);
  const points = values.map((value, index) => ({
    x: values.length > 1 ? (index / (values.length - 1)) * width : width / 2,
    y: height - (value / maximum) * (height - 3) - 1.5,
  }));
  const line = smoothPath(points, 1.5, height - 1.5);
  const area = points.length > 0 ? `${line} L ${width} ${height} L 0 ${height} Z` : "";
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="h-8 w-full overflow-visible"
      role="presentation"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId.current} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {area && <path d={area} fill={`url(#${gradientId.current})`} />}
      {line && (
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

function StatCard({
  label,
  value,
  detail,
  values,
  color,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  values: number[];
  color: string;
}) {
  return (
    <div className={`flex min-w-[172px] flex-1 shrink-0 snap-start flex-col justify-between gap-3 p-4 sm:min-w-0 sm:p-5 ${CARD_CLASSES}`}>
      <div className="min-w-0">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <div className="mt-1.5 truncate text-2xl font-semibold leading-8 tracking-tight tabular-nums">{value}</div>
        {detail && <div className="mt-1 truncate text-xs text-muted-foreground">{detail}</div>}
      </div>
      <Sparkline values={values} color={color} />
    </div>
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
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const width = Math.max(compactView ? 240 : 360, measuredWidth);
  const height = compactView ? 250 : 322;
  const inset = compactView
    ? { top: 12, right: 4, bottom: 30, left: 58 }
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

  const updateHoverFromClientX = useCallback((clientX: number) => {
    const svg = containerRef.current?.querySelector("svg");
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const scaleX = rect.width > 0 ? width / rect.width : 1;
    const localX = (clientX - rect.left) * scaleX;
    const ratio = Math.min(1, Math.max(0, (localX - inset.left) / Math.max(1, chartWidth)));
    setHoverIndex(Math.round(ratio * (days.length - 1)));
  }, [width, inset.left, chartWidth, days.length]);

  const hoverDay = hoverIndex !== null ? days[hoverIndex] : null;
  const hoverSeries = hoverIndex !== null
    ? series
        .map((item) => ({ id: item.id, name: item.name, value: item.values[hoverIndex!] }))
        .filter((item) => item.value > 0)
        .sort((a, b) => b.value - a.value)
    : [];
  const tooltipLeft = hoverIndex !== null ? x(hoverIndex) : 0;
  const tooltipOnRight = tooltipLeft < width * 0.6;

  return (
    <div ref={containerRef} className="relative min-w-0 overflow-hidden">
      <svg
        width={width}
        height={height}
        className="block max-w-full touch-pan-y"
        role="img"
        aria-label={`Daily ${mode} by ${groupBy}`}
        onPointerMove={(event) => updateHoverFromClientX(event.clientX)}
        onPointerDown={(event) => updateHoverFromClientX(event.clientX)}
        onPointerLeave={() => setHoverIndex(null)}
      >
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
              <text x={inset.left - 10} y={y(value) + 4} textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">
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

        {hoverIndex !== null && (
          <g pointerEvents="none">
            <line
              x1={x(hoverIndex)}
              x2={x(hoverIndex)}
              y1={inset.top}
              y2={inset.top + chartHeight}
              className="stroke-foreground/25"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            {series.map((item) => (
              <circle
                key={item.id}
                cx={x(hoverIndex)}
                cy={y(item.values[hoverIndex])}
                r="3.5"
                fill={providerColor(item.id)}
                stroke="var(--background)"
                strokeWidth="1.5"
              />
            ))}
          </g>
        )}

        {[0, Math.floor((days.length - 1) / 2), days.length - 1].map((index, labelIndex) => (
          <text
            key={`${days[index]}:${labelIndex}`}
            x={x(index)}
            y={height - 7}
            textAnchor={labelIndex === 0 ? "start" : labelIndex === 2 ? "end" : "middle"}
            className="fill-muted-foreground text-[11px] tabular-nums"
          >
            {formatDay(days[index])}
          </text>
        ))}
      </svg>

      {hoverIndex !== null && hoverDay && (
        <div
          className="pointer-events-none absolute top-2 z-10 min-w-[140px] max-w-[220px] rounded-lg border border-border/70 bg-popover px-2.5 py-2 text-xs shadow-md"
          style={{
            left: tooltipOnRight ? Math.min(tooltipLeft + 12, width - 12) : undefined,
            right: tooltipOnRight ? undefined : Math.max(width - tooltipLeft + 12, 12),
          }}
        >
          <div className="font-medium text-foreground">{formatDay(hoverDay, true)}</div>
          {hoverSeries.length === 0 ? (
            <div className="mt-1 text-muted-foreground">No usage</div>
          ) : (
            <div className="mt-1.5 space-y-1">
              {hoverSeries.slice(0, 6).map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-1.5 truncate text-muted-foreground">
                    <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: providerColor(item.id) }} />
                    <span className="truncate">{item.name}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-foreground">{formatValue(item.value)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProviderCostRow({
  item,
  total,
}: {
  item: { id: string; name: string; cost: number; tokens: number };
  total: number;
}) {
  const share = total > 0 ? (item.cost / total) * 100 : 0;
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-4 text-sm">
        <span className="flex min-w-0 items-center gap-2.5 font-medium">
          <ProviderLogo id={item.id} name={item.name} size="md" />
          <span className="truncate">{item.name}</span>
        </span>
        <span className="shrink-0 tabular-nums"><CostValue value={item.cost} /></span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{
            width: `${share}%`,
            minWidth: item.cost > 0 ? 3 : 0,
            backgroundColor: providerColor(item.id),
          }}
        />
      </div>
      <div className="mt-2 text-xs text-muted-foreground">{percentage(item.cost, total)} of cost · {compact(item.tokens)} tokens</div>
    </div>
  );
}

function ChartLegend({ providers }: { providers: Array<{ id: string; name: string }> }) {
  if (providers.length === 0) return null;
  return (
    <div
      aria-label="Chart series"
      className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs text-muted-foreground"
    >
      {providers.map((item) => (
        <span key={item.id} className="flex items-center gap-1.5 whitespace-nowrap">
          <ProviderLogo id={item.id} name={item.name} size="sm" />
          {item.name}
        </span>
      ))}
    </div>
  );
}

const CARD_CLASSES = "rounded-xl border border-border/70 bg-muted/[0.08]";

// A project row names its highest-cost agent and folds the rest into `+N`,
// which lists them with their own cost on hover or focus.
function AgentCell({
  agentId,
  agent,
  others,
}: {
  agentId: string;
  agent: string;
  others?: Array<{ id: string; name: string; cost: number }>;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2 text-muted-foreground">
      <ProviderLogo id={agentId} name={agent} size="sm" />
      <span className="truncate">{agent}</span>
      {others && others.length > 0 && (
        <TooltipProvider>
          <Tooltip delayDuration={150}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`${others.length} more ${others.length === 1 ? "agent" : "agents"}`}
                className="shrink-0 rounded border border-border/60 bg-muted/40 px-1 py-0.5 text-[10px] font-medium leading-none tabular-nums text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                +{others.length}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <div className="font-medium text-foreground/90">Also used here</div>
              <div className="mt-1 space-y-0.5">
                {others.map((item) => (
                  <div key={item.id} className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <ProviderLogo id={item.id} name={item.name} size="sm" />
                      <span className="truncate">{item.name}</span>
                    </span>
                    <span className="shrink-0 tabular-nums">{money(item.cost)}</span>
                  </div>
                ))}
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </span>
  );
}

function RowBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border/50 bg-muted/40 px-1.5 py-1 text-[11px] leading-none text-muted-foreground">
      {children}
    </span>
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
    <section className="rounded-xl border border-border/70 bg-muted/[0.08] p-4 sm:p-5" aria-labelledby="provider-limits-title">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="provider-limits-title" className="text-sm font-medium">Usage limits</h2>
        <span className="text-xs text-muted-foreground">Current plan windows</span>
      </div>
      {machines.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">No provider limits are available from connected machines.</p>
      ) : (
        <div
          className={`mt-4 grid gap-3 ${constrainHeight ? "max-h-60 overflow-y-auto pr-1" : ""}`}
          style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}
        >
          {machines.map((machine) => (
            <div
              key={machine.machineId}
              className="min-w-0 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5"
            >
              <div className="truncate text-[11px] font-medium leading-4 text-muted-foreground" title={machine.machineName}>
                {machine.machineName}
              </div>
              <div className="mt-2 divide-y divide-border/50 border-t border-border/50">
                {machine.providers.map((limit) => (
                  <div key={limit.providerId} className="py-2.5 first:pt-2 last:pb-0.5">
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <span className="flex min-w-0 items-center gap-2">
                        <ProviderLogo id={limit.providerId} name={limit.providerName} size="sm" />
                        <span className="truncate text-xs font-medium">{limit.providerName}</span>
                      </span>
                      {limit.planLabel && <div className="max-w-[45%] shrink-0 truncate text-[10px] text-muted-foreground" title={limit.planLabel}>{limit.planLabel}</div>}
                    </div>
                    {limit.status === "error" ? (
                      <div className="mt-2 flex items-start gap-1.5">
                        <Icon name="AlertCircle" className="mt-px size-3.5 shrink-0 text-destructive" aria-hidden="true" />
                        <p className="text-[10px] leading-4 text-destructive/90">
                          {limit.error ? `Couldn’t load ${limit.providerName} limits: ${limit.error}` : `${limit.providerName} limits unavailable`}
                        </p>
                      </div>
                    ) : (
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
                    )}
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
function UsageLimitsToggle() {
  const toolbar = useUsageToolbar();

  return (
    <label className="inline-flex h-8 cursor-pointer items-center gap-2 whitespace-nowrap rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground">
      <Checkbox
        checked={toolbar.showUsageLimits}
        onCheckedChange={(checked) => rememberShowUsageLimits(checked === true)}
        aria-label="Show usage limits"
      />
      <span>Usage limits</span>
    </label>
  );
}

function UsageToolbarControls({ placement }: { placement: "header" | "body" }) {
  const toolbar = useUsageToolbar();
  const inBody = placement === "body";
  const selectedMachineLabel = toolbar.machine === "all"
    ? "All machines"
    : toolbar.machines.find((item) => item.id === toolbar.machine)?.name;

  const rangeSelect = (
    <div className={`min-w-0 ${inBody ? "w-full" : "w-[132px]"}`}>
      <MachineFilter
        value={String(toolbar.range)}
        onChange={(value) => updateUsageToolbar({ range: Number(value) as Range })}
        ariaLabel="Usage duration"
        contentWidth={148}
        fill
        triggerLabel={`Last ${toolbar.range} days`}
        options={[7, 30, 90].map((value) => ({ value: String(value), label: `Last ${value} days` }))}
      />
    </div>
  );
  const machineSelect = (
    <div className={`min-w-0 ${inBody ? "w-full" : "w-[200px]"}`}>
      <MachineFilter
        value={toolbar.machine}
        onChange={(machine) => updateUsageToolbar({ machine })}
        ariaLabel="Filter usage by machine"
        contentWidth={240}
        fill
        triggerLabel={selectedMachineLabel}
        options={[{ value: "all", label: "All machines" }, ...toolbar.machines.map((item) => ({ value: item.id, label: item.name }))]}
      />
    </div>
  );
  if (!inBody) {
    return (
      <div className="flex min-w-0 flex-nowrap items-center gap-2">
        <div className="shrink-0"><UsageLimitsToggle /></div>
        <div className="shrink-0">{rangeSelect}</div>
        <div className="shrink-0">{machineSelect}</div>
        <div className="shrink-0"><UsageSyncButton /></div>
      </div>
    );
  }
  return (
    <section aria-label="Usage filters" className="min-w-0 rounded-xl border border-border/60 bg-muted/[0.08] p-2">
      <div className="grid min-w-0 grid-cols-[minmax(112px,0.72fr)_minmax(0,1.28fr)] gap-2">
        {rangeSelect}
        {machineSelect}
      </div>
    </section>
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
  const compactHeader = useMediaQuery("(max-width: 1279px)");

  useEffect(() => {
    try {
      updateUsageToolbar({ showUsageLimits: window.localStorage.getItem(SHOW_USAGE_LIMITS_STORAGE_KEY) === "true" });
    } catch {
      // Keep the default unchecked state when storage is unavailable.
    }
  }, []);

  if (compactHeader) {
    return (
      <div className="flex items-center gap-1">
        <UsageLimitsToggle />
        <UsageSyncButton />
      </div>
    );
  }
  return <UsageToolbarControls placement="header" />;
}

function UsageResponsiveControls() {
  const compactHeader = useMediaQuery("(max-width: 1279px)");
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
  const [chartMode, setChartMode] = useState<ChartMode>("cost");
  const [breakdownMode, setBreakdownMode] = useState<BreakdownMode>("model");
  const [mobileSection, setMobileSection] = useState<"chart" | "breakdown">("chart");
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

  const dailySeries = useMemo(() => {
    const days = rangeDays(range);
    const empty = () => new Map(days.map((day) => [day, 0]));
    const buckets = { cost: empty(), processed: empty(), cached: empty(), output: empty(), cacheSavings: empty() };
    for (const row of rows) {
      if (!buckets.cost.has(row.day)) continue;
      buckets.cost.set(row.day, buckets.cost.get(row.day)! + row.costUsd);
      buckets.processed.set(row.day, buckets.processed.get(row.day)! + row.processedTokens);
      buckets.cached.set(row.day, buckets.cached.get(row.day)! + row.cachedInputTokens);
      buckets.output.set(row.day, buckets.output.get(row.day)! + row.outputTokens);
      buckets.cacheSavings.set(row.day, buckets.cacheSavings.get(row.day)! + row.cacheSavingsUsd);
    }
    const toArray = (map: Map<string, number>) => days.map((day) => map.get(day) ?? 0);
    return {
      cost: toArray(buckets.cost),
      processed: toArray(buckets.processed),
      cached: toArray(buckets.cached),
      output: toArray(buckets.output),
      cacheSavings: toArray(buckets.cacheSavings),
    };
  }, [rows, range]);

  type BreakdownRow = {
    key: string; label: string; agent: string; agentId: string; provider: string; providerId: string;
    cost: number; tokens: number;
    // Only project rows fold several agents into one badge; the folded ones are
    // listed here so the `+N` suffix can name them on hover.
    otherAgents?: Array<{ id: string; name: string; cost: number }>;
  };
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

  // Projects can be worked on from several agents and providers, so a row keeps
  // the dominant one by cost for its badge instead of claiming a single owner.
  const projectBreakdown = useMemo(() => {
    const map = new Map<string, BreakdownRow & { byAgent: Map<string, { name: string; cost: number }> }>();
    for (const row of rows) {
      const current = map.get(row.project) ?? {
        key: row.project, label: row.project, agent: row.agentName, agentId: row.agentId,
        provider: row.modelProviderName, providerId: row.modelProviderId, cost: 0, tokens: 0,
        byAgent: new Map<string, { name: string; cost: number }>(),
      };
      current.cost += row.costUsd;
      current.tokens += row.processedTokens;
      const agent = current.byAgent.get(row.agentId) ?? { name: row.agentName, cost: 0 };
      agent.cost += row.costUsd;
      current.byAgent.set(row.agentId, agent);
      map.set(row.project, current);
    }
    return [...map.values()].map((item) => {
      const ranked = [...item.byAgent.entries()]
        .map(([id, value]) => ({ id, name: value.name, cost: value.cost }))
        .sort((a, b) => b.cost - a.cost);
      const [dominant, ...others] = ranked;
      return {
        ...item,
        agentId: dominant?.id ?? item.agentId,
        agent: dominant?.name ?? item.agent,
        otherAgents: others,
      };
    }).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
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
  // A single dimension control (next to the chart) drives both the chart and
  // the cost rows so the agent/provider tabs never repeat.
  const costDimension = chartGroup;
  const costDimensions = costDimension === "agent" ? activeAgents : activeModelProviders;
  const providerTotals = costDimensions.map((item) => ({
    ...item,
    cost: rows.filter((row) => (costDimension === "agent" ? row.agentId : row.modelProviderId) === item.id).reduce((sum, row) => sum + row.costUsd, 0),
    tokens: rows.filter((row) => (costDimension === "agent" ? row.agentId : row.modelProviderId) === item.id).reduce((sum, row) => sum + row.processedTokens, 0),
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
  const breakdown = breakdownMode === "model" ? modelBreakdown
    : breakdownMode === "project" ? projectBreakdown
    : dayBreakdown;
  const paginatedBreakdown = paginateItems(breakdown, breakdownPage, BREAKDOWN_PAGE_SIZE);
  const activeDays = new Set(rows.map((row) => row.day)).size;
  const visibleProviderLimits = data.providerLimits.filter((limit) => machine === "all" || limit.machineId === machine);

  const metrics = [
    { label: "Processed tokens", value: compact(totals.processed), detail: `${compact(totals.processed / Math.max(1, activeDays))} per active day`, values: dailySeries.processed, color: FALLBACK_PROVIDER_COLORS[0] },
    { label: "Cached input", value: compact(totals.cached), detail: `${percentage(totals.cached, totals.cached + totals.uncached)} of input · ${compact(totals.cacheWrites)} writes`, values: dailySeries.cached, color: FALLBACK_PROVIDER_COLORS[1] },
    { label: "Output", value: compact(totals.output), detail: "Includes reasoning tokens", values: dailySeries.output, color: FALLBACK_PROVIDER_COLORS[2] },
    { label: "Cache savings", value: money(totals.cacheSavings), detail: totals.cost > 0 ? `${(totals.cacheSavings / totals.cost).toFixed(1)}× the raw token cost` : `Price sheet ${data.pricingVersion}`, cost: totals.cacheSavings, values: dailySeries.cacheSavings, color: FALLBACK_PROVIDER_COLORS[3] },
  ];

  return (
    <div className="h-full overflow-y-auto bg-background">
      <main
        ref={mainRef}
        className="mx-auto flex min-h-full w-full max-w-[1440px] flex-col gap-4 px-4 py-3 sm:gap-5 sm:px-5 sm:py-5 md:px-6 lg:gap-8"
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
            {stackedView && (
              <ToggleGroup
                value={mobileSection}
                onChange={setMobileSection}
                label="Dashboard section"
                fill
                options={[{ value: "chart", label: "Usage chart" }, { value: "breakdown", label: "Breakdown" }]}
              />
            )}

            {(!stackedView || mobileSection === "chart") && (
            <>
            <section
              className={`grid items-stretch ${stackedView ? "gap-4 sm:gap-5" : "gap-10 lg:gap-14"}`}
              style={stackedView ? undefined : { gridTemplateColumns: "minmax(330px, 0.92fr) minmax(0, 1.65fr)" }}
            >
              <div className={stackedView ? `flex min-w-0 flex-col p-4 sm:p-5 ${CARD_CLASSES}` : "relative flex min-w-0 flex-col"}>
                <div className={stackedView ? "flex min-w-0 flex-col" : "absolute inset-0 flex min-w-0 flex-col"}>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">Raw token cost</span>
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
                </div>
                <div
                  className="mt-2 font-semibold tracking-tight tabular-nums"
                  style={{
                    fontSize: compactView ? 36 : 42,
                    lineHeight: compactView ? "40px" : "46px",
                    letterSpacing: "-0.025em",
                  }}
                >
                  <CostValue value={totals.cost} />
                  *
                </div>
                <div className="mt-1 text-sm text-muted-foreground">If billed at standard API rates</div>
                {!stackedView && (
                  <div className="mt-7 min-h-0 flex-1 space-y-6 overflow-y-auto pr-3">
                    {providerTotals.map((item) => (
                      <ProviderCostRow key={item.id} item={item} total={totals.cost} />
                    ))}
                  </div>
                )}

                {stackedView && (
                  <div className="mt-5 min-w-0 border-t border-border/60 pt-4">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
                      <h2 className="mr-auto text-sm font-semibold">Daily {chartMode === "cost" ? "cost" : "tokens"}</h2>
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
                    <div className="mt-2">
                      <ChartLegend providers={activeProviders} />
                    </div>
                  </div>
                  )}
                </div>
              </div>

              {!stackedView && (
                <div className="flex min-w-0 flex-col">
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
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
                  <div className="mt-2">
                    <ChartLegend providers={activeProviders} />
                  </div>
                </div>
              )}

              {stackedView && providerTotals.length > 0 && (
                <div>
                  <h2 className="mb-2.5 text-sm font-medium text-muted-foreground">{chartGroup === "agent" ? "Agents" : "Model providers"}</h2>
                  <div className={`overflow-hidden ${CARD_CLASSES}`}>
                    {providerTotals.map((item) => (
                      <div key={item.id} className="border-t border-border/60 px-4 py-3.5 first:border-t-0">
                        <ProviderCostRow item={item} total={totals.cost} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>

            <section>
              <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:snap-none sm:gap-4 sm:overflow-visible sm:px-0 sm:pb-0" style={{ gridTemplateColumns: `repeat(${metrics.length}, minmax(0, 1fr))` }}>
                {metrics.map((metric) => (
                  <StatCard
                    key={metric.label}
                    label={metric.label}
                    value={"cost" in metric && typeof metric.cost === "number" ? <CostValue value={metric.cost} /> : metric.value}
                    detail={metric.detail}
                    values={metric.values}
                    color={metric.color}
                  />
                ))}
              </div>
            </section>
            </>
            )}

            {(!stackedView || mobileSection === "breakdown") && (
            <section>
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-sm font-semibold">Breakdown</h2>
                <ToggleGroup
                  value={breakdownMode}
                  onChange={setBreakdownMode}
                  label="Breakdown grouping"
                  options={[{ value: "model", label: "Model" }, { value: "project", label: "Project" }, { value: "day", label: "Day" }]}
                />
              </div>

              {compactView ? (
                <div className={`mt-3 overflow-hidden ${CARD_CLASSES}`}>
                  {paginatedBreakdown.items.map((row) => (
                    <div key={row.key} className="border-t border-border/60 px-3.5 py-3 first:border-t-0">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                          {breakdownMode === "model" && (
                            <ProviderLogo id={modelLogoId(row.label)} size="sm" />
                          )}
                          <span className="truncate">{row.label}</span>
                        </span>
                        <span className="shrink-0 text-sm font-medium tabular-nums"><CostValue value={row.cost} /></span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
                        {breakdownMode !== "day" && (
                          <RowBadge>
                            <ProviderLogo id={row.agentId} name={row.agent} size="sm" />
                            <span className="max-w-[110px] truncate">{row.agent}</span>
                            {row.otherAgents && row.otherAgents.length > 0 && (
                              <span
                                className="shrink-0 tabular-nums text-foreground/70"
                                title={row.otherAgents.map((item) => `${item.name} ${money(item.cost)}`).join(" · ")}
                              >
                                +{row.otherAgents.length}
                              </span>
                            )}
                          </RowBadge>
                        )}
                        <RowBadge>
                          <span className="tabular-nums text-foreground/80">{compact(row.tokens)}</span>
                          <span>tokens</span>
                        </RowBadge>
                        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">{percentage(row.cost, totals.cost)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className={`mt-3 overflow-x-auto ${CARD_CLASSES}`}>
                  <table className="w-full border-collapse text-sm" style={{ minWidth: breakdownMode === "day" ? 520 : 640 }}>
                    <thead>
                      <tr className="border-b border-border bg-muted/20 text-xs text-muted-foreground">
                        <th className="px-4 py-2.5 text-left font-medium">
                          {breakdownMode === "model" ? "Model" : breakdownMode === "project" ? "Project" : "Day"}
                        </th>
                        {breakdownMode !== "day" && (
                          <th className="px-4 py-2.5 text-left font-medium">Agent</th>
                        )}
                        <th className="px-4 py-2.5 text-right font-medium">Cost</th>
                        <th className="px-4 py-2.5 text-right font-medium">Share</th>
                        <th className="px-4 py-2.5 text-right font-medium">Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedBreakdown.items.map((row) => (
                        <tr key={row.key} className="border-b border-border/60 transition-colors duration-150 hover:bg-muted/20 last:border-0">
                          <td className="px-4 py-3 font-medium">
                            {breakdownMode === "model" ? (
                              <span className="inline-flex min-w-0 items-center gap-2">
                                <ProviderLogo id={modelLogoId(row.label)} size="sm" />
                                <span className="truncate" title={`${row.label} · ${row.provider}`}>{row.label}</span>
                              </span>
                            ) : (
                              <span className="truncate" title={row.label}>{row.label}</span>
                            )}
                          </td>
                          {breakdownMode !== "day" && (
                            <td className="px-4 py-3">
                              <AgentCell agentId={row.agentId} agent={row.agent} others={row.otherAgents} />
                            </td>
                          )}
                          <td className="px-4 py-3 text-right tabular-nums"><CostValue value={row.cost} /></td>
                          <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{percentage(row.cost, totals.cost)}</td>
                          <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{compact(row.tokens)}</td>
                        </tr>
                      ))}
                    </tbody>
                   </table>
                 </div>
               )}

               {breakdown.length > BREAKDOWN_PAGE_SIZE && (
                 <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-xs tabular-nums text-muted-foreground sm:justify-end">
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
             )}
           </>
         )}

        <footer className={`flex flex-col gap-2 pb-1 text-xs text-muted-foreground sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-x-4 ${rows.length > 0 ? "border-t border-border/70 pt-4" : "pt-2"}`}>
          {rows.length > 0 && <span className="min-w-0 flex-1 leading-5 sm:max-w-[60%]">{data.notice} Costs use models.dev pricing as of {data.pricingVersion}.</span>}
          <a
            href="https://github.com/MayankBansal12/bb-plugin-usage/issues"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 self-start rounded-md px-2 py-1.5 font-medium transition-[background-color,color,transform] duration-150 ease-out hover:bg-muted/50 hover:text-foreground active:scale-[0.97] sm:ml-auto sm:self-auto"
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
