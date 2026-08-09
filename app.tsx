import { useEffect, useMemo, useRef, useState } from "react";
import { definePluginApp, useRealtime, useRealtimeConnectionState, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Range = 7 | 30 | 90;

const PROVIDER_STYLES = ["text-primary", "text-chart-2", "text-chart-3"];

function money(value: number) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function compact(value: number) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function UsageChart({ records, providerIds }: { records: UsageRecord[]; providerIds: string[] }) {
  const width = 920;
  const height = 280;
  const inset = 30;
  const days = Array.from(new Set(records.map((row) => row.day))).sort();
  const series = providerIds.map((providerId) => ({
    providerId,
    values: days.map((day) => records.filter((row) => row.day === day && row.providerId === providerId).reduce((sum, row) => sum + row.costUsd, 0)),
  }));
  const max = Math.max(1, ...series.flatMap((item) => item.values));
  const x = (index: number) => inset + (index / Math.max(1, days.length - 1)) * (width - inset * 2);
  const y = (value: number) => height - inset - (value / max) * (height - inset * 2);

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height}`} className="min-w-[680px] w-full" role="img" aria-label="Daily usage cost by provider">
        {[0, 0.25, 0.5, 0.75, 1].map((step) => (
          <g key={step}>
            <line x1={inset} x2={width - inset} y1={y(max * step)} y2={y(max * step)} className="stroke-border" strokeWidth="1" />
            <text x={inset} y={y(max * step) - 6} className="fill-muted-foreground text-[10px]">{money(max * step)}</text>
          </g>
        ))}
        {series.map((item, seriesIndex) => {
          const points = item.values.map((value, index) => `${x(index)},${y(value)}`).join(" ");
          return <polyline key={item.providerId} points={points} fill="none" stroke="currentColor" strokeWidth="2.5" className={PROVIDER_STYLES[seriesIndex % PROVIDER_STYLES.length]} />;
        })}
        {days.length > 0 && <>
          <text x={inset} y={height - 7} className="fill-muted-foreground text-[10px]">{days[0]}</text>
          <text x={width - inset} y={height - 7} textAnchor="end" className="fill-muted-foreground text-[10px]">{days[days.length - 1]}</text>
        </>}
      </svg>
    </div>
  );
}

type UsageRecord = {
  day: string; providerId: string; providerName: string; machineId: string; machineName: string;
  model: string; costUsd: number; cacheSavingsUsd: number; processedTokens: number; cachedInputTokens: number;
  cacheWriteTokens: number; uncachedInputTokens: number; outputTokens: number;
};

type DashboardData = {
  mode: "live"; generatedAt: string; lastSyncedAt: string | null; pricingVersion: string;
  machines: Array<{ id: string; name: string; status?: string }>;
  providers: Array<{ id: string; name: string; status?: string }>;
  records: UsageRecord[];
  sources: Array<{ machineId: string; providerId: string; status: string; lastAttemptAt: string | null; lastSuccessAt: string | null; recordCount: number; error: string | null }>;
  notice: string;
};

function FilterPill({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return <Button size="sm" variant={active ? "default" : "outline"} onClick={onClick}>{children}</Button>;
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
  const [syncing, setSyncing] = useState(false);

  const load = () => {
    setError(null);
    void rpc.call("dashboard").then(setData).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  const sync = () => {
    setSyncing(true);
    setError(null);
    void rpc.call("sync").then(() => rpc.call("dashboard")).then(setData).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setSyncing(false));
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
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - range + 1);
    const cutoffDay = cutoff.toISOString().slice(0, 10);
    return data.records.filter((row) => row.day >= cutoffDay && (provider === "all" || row.providerId === provider) && (machine === "all" || row.machineId === machine));
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

  const breakdown = useMemo(() => {
    const map = new Map<string, { model: string; provider: string; cost: number; tokens: number }>();
    rows.forEach((row) => {
      const current = map.get(row.model) ?? { model: row.model, provider: row.providerName, cost: 0, tokens: 0 };
      current.cost += row.costUsd;
      current.tokens += row.processedTokens;
      map.set(row.model, current);
    });
    return [...map.values()].sort((a, b) => b.cost - a.cost);
  }, [rows]);

  if (error) return <div className="p-6 text-sm text-destructive">Could not load usage: {error}</div>;
  if (!data) return <div className="p-6 text-sm text-muted-foreground">Loading usage…</div>;

  const activeProviderIds = data.providers.filter((item) => provider === "all" || item.id === provider).map((item) => item.id);
  const visibleSources = data.sources.filter((source) => (provider === "all" || source.providerId === provider) && (machine === "all" || source.machineId === machine));
  const sourceIssues = visibleSources.filter((source) => !["ready", "no-data"].includes(source.status));

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-7xl space-y-4 p-4 md:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2"><h2 className="text-lg font-semibold">All usage combined</h2><span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">Local logs</span></div>
            <p className="text-sm text-muted-foreground">{data.machines.length} enrolled machines · last {range} days{data.lastSyncedAt ? ` · synced ${new Date(data.lastSyncedAt).toLocaleString()}` : " · waiting for first sync"}</p>
          </div>
          <div className="flex gap-1">{([7, 30, 90] as const).map((value) => <FilterPill key={value} active={range === value} onClick={() => setRange(value)}>{value} days</FilterPill>)}<Button size="sm" variant="outline" disabled={syncing} onClick={sync}>{syncing ? "Syncing…" : "Sync now"}</Button></div>
        </div>

        <Card className="border-dashed"><CardContent className="py-3 text-sm text-muted-foreground">{data.notice}</CardContent></Card>

        {rows.length === 0 && <Card><CardContent className="py-5"><div className="font-medium">No usage records for this view yet</div><p className="mt-1 text-sm text-muted-foreground">Run a sync, connect an offline machine, or use an installed provider to generate local usage logs.</p><div className="mt-3 flex flex-wrap gap-2">{visibleSources.map((source) => <span key={`${source.machineId}:${source.providerId}`} title={source.error ?? undefined} className="rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">{data.machines.find((item) => item.id === source.machineId)?.name ?? source.machineId} · {data.providers.find((item) => item.id === source.providerId)?.name ?? source.providerId}: {source.status}</span>)}</div></CardContent></Card>}

        <div className="flex flex-wrap gap-2">
          <FilterPill active={provider === "all"} onClick={() => setProvider("all")}>All subscriptions</FilterPill>
          {data.providers.map((item) => <FilterPill key={item.id} active={provider === item.id} onClick={() => setProvider(item.id)}>{item.name}</FilterPill>)}
          <span className="mx-1 hidden h-8 w-px bg-border sm:block" />
          <FilterPill active={machine === "all"} onClick={() => setMachine("all")}>All machines</FilterPill>
          {data.machines.map((item) => <FilterPill key={item.id} active={machine === item.id} onClick={() => setMachine(item.id)}>{item.name}</FilterPill>)}
        </div>

        {sourceIssues.length > 0 && <Card className="border-dashed"><CardContent className="py-3"><div className="text-sm font-medium">Some local history may be incomplete</div><div className="mt-2 flex flex-wrap gap-2">{sourceIssues.map((source) => <span key={`${source.machineId}:${source.providerId}`} title={source.error ?? undefined} className="rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">{data.machines.find((item) => item.id === source.machineId)?.name ?? source.machineId} · {data.providers.find((item) => item.id === source.providerId)?.name ?? source.providerId}: {source.status}</span>)}</div></CardContent></Card>}

        <div className="grid gap-4 lg:grid-cols-[minmax(260px,0.7fr)_minmax(0,1.8fr)]">
          <Card><CardHeader><CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Raw token cost</CardTitle></CardHeader><CardContent><div className="text-4xl font-semibold tabular-nums">{money(totals.cost)}*</div><p className="mt-1 text-xs text-muted-foreground">Estimated at public API rates</p><div className="mt-5 space-y-3">{data.providers.map((item) => { const value = rows.filter((row) => row.providerId === item.id).reduce((sum, row) => sum + row.costUsd, 0); return <div key={item.id}><div className="flex justify-between text-sm"><span>{item.name}</span><span className="tabular-nums">{money(value)}</span></div><div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary" style={{ width: `${totals.cost ? (value / totals.cost) * 100 : 0}%` }} /></div></div>; })}</div></CardContent></Card>
          <Card><CardHeader><div className="flex items-center justify-between"><CardTitle>Daily cost</CardTitle><div className="flex gap-3 text-xs text-muted-foreground">{activeProviderIds.map((id, index) => <span key={id} className={PROVIDER_STYLES[index % PROVIDER_STYLES.length]}>● {data.providers.find((item) => item.id === id)?.name}</span>)}</div></div></CardHeader><CardContent><UsageChart records={rows} providerIds={activeProviderIds} /></CardContent></Card>
        </div>

        <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 lg:grid-cols-5">{[
          ["Processed tokens", compact(totals.processed), `${compact(totals.processed / range)} per day`],
          ["Cached input", compact(totals.cached), `${totals.processed ? ((totals.cached / totals.processed) * 100).toFixed(1) : 0}% of processed`],
          ["Uncached input", compact(totals.uncached), `${compact(totals.cacheWrites)} cache writes`],
          ["Output", compact(totals.output), "Includes reasoning"],
          ["Cache savings", money(totals.cacheSavings), `Price sheet ${data.pricingVersion}`],
        ].map(([label, value, detail]) => <div key={label} className="bg-card p-4"><div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div><div className="mt-1 text-xl font-semibold tabular-nums">{value}</div><div className="text-xs text-muted-foreground">{detail}</div></div>)}</div>

        <Card><CardHeader><CardTitle>Breakdown by model</CardTitle></CardHeader><CardContent className="p-0"><div className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-5 py-3 font-medium">Model</th><th className="px-5 py-3 font-medium">Provider</th><th className="px-5 py-3 text-right font-medium">Cost</th><th className="px-5 py-3 text-right font-medium">Share</th><th className="px-5 py-3 text-right font-medium">Tokens</th></tr></thead><tbody>{breakdown.map((row) => <tr key={row.model} className="border-b border-border last:border-0"><td className="px-5 py-3 font-medium">{row.model}</td><td className="px-5 py-3 text-muted-foreground">{row.provider}</td><td className="px-5 py-3 text-right tabular-nums">{money(row.cost)}</td><td className="px-5 py-3 text-right tabular-nums text-muted-foreground">{totals.cost ? ((row.cost / totals.cost) * 100).toFixed(1) : 0}%</td><td className="px-5 py-3 text-right tabular-nums">{compact(row.tokens)}</td></tr>)}</tbody></table></div></CardContent></Card>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "usage", title: "Usage", icon: "ChartColumn", path: "usage", component: UsageDashboard });
});
