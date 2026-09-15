// Pure slicing logic for the breakdown share donut. Rows are ranked by the
// active metric; the top slices stay individual and the rest fold into Other
// so long breakdowns stay readable. `colorByKey` lets each table row carry a
// dot matching its slice, so the table itself acts as the legend.

export const DONUT_TOP_SLICES = 7;
export const OTHER_SLICE_KEY = "$other";
// Neutral gray for the folded tail, readable on both light and dark themes.
export const OTHER_SLICE_COLOR = "#94A3B8";
// Same family as FALLBACK_PROVIDER_COLORS in app.tsx, extended to cover
// DONUT_TOP_SLICES distinct slices.
export const BREAKDOWN_DONUT_PALETTE = ["#0EA5E9", "#F59E0B", "#EC4899", "#14B8A6", "#8B5CF6", "#F97316", "#84CC16"];

export type DonutMode = "cost" | "tokens";

export type DonutRow = {
  key: string;
  label: string;
  cost: number;
  tokens: number;
  unknown?: boolean;
};

export type DonutSlice = {
  key: string;
  label: string;
  value: number;
  share: number;
  color: string;
  otherCount: number;
};

export type BreakdownDonutData = {
  slices: DonutSlice[];
  colorByKey: Map<string, string>;
  total: number;
  // Cost-mode rows whose usage has no known price contribute nothing to the
  // donut; the component footnotes this count.
  unpricedCount: number;
};

export function metricValue(row: Pick<DonutRow, "cost" | "tokens">, mode: DonutMode) {
  return mode === "cost" ? row.cost : row.tokens;
}

export function buildBreakdownDonut(rows: DonutRow[], mode: DonutMode): BreakdownDonutData {
  const total = rows.reduce((sum, row) => sum + metricValue(row, mode), 0);
  const secondaryMode: DonutMode = mode === "cost" ? "tokens" : "cost";
  const ranked = rows
    .filter((row) => metricValue(row, mode) > 0)
    .sort((a, b) => metricValue(b, mode) - metricValue(a, mode) || metricValue(b, secondaryMode) - metricValue(a, secondaryMode));

  const slices: DonutSlice[] = ranked.slice(0, DONUT_TOP_SLICES).map((row, index) => ({
    key: row.key,
    label: row.label,
    value: metricValue(row, mode),
    share: total > 0 ? metricValue(row, mode) / total : 0,
    color: BREAKDOWN_DONUT_PALETTE[index % BREAKDOWN_DONUT_PALETTE.length],
    otherCount: 0,
  }));

  const folded = ranked.slice(DONUT_TOP_SLICES);
  if (folded.length > 0) {
    const value = folded.reduce((sum, row) => sum + metricValue(row, mode), 0);
    slices.push({
      key: OTHER_SLICE_KEY,
      label: "Other",
      value,
      share: total > 0 ? value / total : 0,
      color: OTHER_SLICE_COLOR,
      otherCount: folded.length,
    });
  }

  const colorByKey = new Map<string, string>();
  for (const slice of slices) {
    if (slice.key !== OTHER_SLICE_KEY) colorByKey.set(slice.key, slice.color);
  }
  for (const row of rows) {
    if (!colorByKey.has(row.key)) colorByKey.set(row.key, OTHER_SLICE_COLOR);
  }

  return {
    slices,
    colorByKey,
    total,
    unpricedCount: mode === "cost" ? rows.filter((row) => row.unknown && row.cost === 0).length : 0,
  };
}
