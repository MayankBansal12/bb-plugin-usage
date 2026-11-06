// Geometry for the "Daily tokens / Daily cost" stacked bar chart. Everything
// here works in plot-local coordinates: x runs [0, chartWidth] left to right,
// y runs [0, chartHeight] top to bottom, so callers translate by their inset.

export const BAR_SEGMENT_GAP = 2;
export const BAR_MIN_WIDTH = 2;
export const BAR_MAX_WIDTH = 96;
export const BAR_GAP_RATIO = 0.4;
export const BAR_TOP_RADIUS = 4;
export const BAR_DIMMED_OPACITY = 0.4;
// Slots narrower than this cannot satisfy the minimum bar width and the 40%
// gap at once; callers should widen the chart (and scroll) instead.
export const BAR_SLOT_MIN_WIDTH = BAR_MIN_WIDTH * (1 + BAR_GAP_RATIO);

export type DailyBarSeries = {
  id: string;
  name: string;
  values: number[];
};

export type DailyBarSegment = {
  seriesId: string;
  y: number;
  height: number;
  roundedTop: boolean;
};

export type DailyBarColumn = {
  dayIndex: number;
  columnX: number;
  columnWidth: number;
  barX: number;
  barWidth: number;
  segments: DailyBarSegment[];
};

export type DailyBarLayout = {
  slotWidth: number;
  barWidth: number;
  columns: DailyBarColumn[];
};

// Largest total goes to the bottom of the stack; the rest descend upward.
export function orderStackedSeries<T extends DailyBarSeries>(series: T[]): T[] {
  return series
    .map((item) => ({ item, total: item.values.reduce((sum, value) => sum + Math.max(0, value), 0) }))
    .sort((left, right) => right.total - left.total || left.item.name.localeCompare(right.item.name))
    .map((entry) => entry.item);
}

// One equal slot per day; the bar fills the slot while keeping the gap between
// bars at >= 40% of the bar width, never narrower than BAR_MIN_WIDTH and never
// wider than the slot itself.
export function dailyBarSize(chartWidth: number, dayCount: number) {
  const slotWidth = chartWidth / Math.max(1, dayCount);
  const fitted = slotWidth / (1 + BAR_GAP_RATIO);
  const barWidth = Math.min(slotWidth, BAR_MAX_WIDTH, Math.max(BAR_MIN_WIDTH, fitted));
  return { slotWidth, barWidth };
}

export function buildDailyBars(input: {
  dayCount: number;
  series: DailyBarSeries[];
  chartWidth: number;
  chartHeight: number;
  maximum: number;
}): DailyBarLayout {
  const { dayCount, series, chartWidth, chartHeight, maximum } = input;
  const { slotWidth, barWidth } = dailyBarSize(chartWidth, dayCount);
  const valueToY = (value: number) => chartHeight - (maximum > 0 ? (value / maximum) * chartHeight : 0);

  const columns: DailyBarColumn[] = [];
  for (let dayIndex = 0; dayIndex < dayCount; dayIndex += 1) {
    const columnX = dayIndex * slotWidth;
    const barX = columnX + (slotWidth - barWidth) / 2;

    let cumulative = 0;
    const rendered: Array<{ seriesId: string; lower: number; upper: number }> = [];
    for (const item of series) {
      const value = Math.max(0, item.values[dayIndex] ?? 0);
      const lower = cumulative;
      cumulative += value;
      if (value > 0) rendered.push({ seriesId: item.id, lower, upper: cumulative });
    }

    const segments = rendered.map((segment, index) => {
      const rawTop = valueToY(segment.upper);
      const rawBottom = valueToY(segment.lower);
      let top = index < rendered.length - 1 ? rawTop + BAR_SEGMENT_GAP / 2 : rawTop;
      let bottom = index > 0 ? rawBottom - BAR_SEGMENT_GAP / 2 : rawBottom;
      // A sliver thinner than the gaps around it keeps its raw bounds so it
      // stays visible instead of collapsing to nothing.
      if (bottom - top < 1) {
        top = rawTop;
        bottom = rawBottom;
      }
      return { seriesId: segment.seriesId, y: top, height: bottom - top, roundedTop: index === rendered.length - 1 };
    });

    columns.push({ dayIndex, columnX, columnWidth: slotWidth, barX, barWidth, segments });
  }
  return { slotWidth, barWidth, columns };
}

// Top corners rounded, bottom flush on the baseline.
export function roundedTopBarPath(x: number, y: number, width: number, height: number, radius = BAR_TOP_RADIUS) {
  const r = Math.max(0, Math.min(radius, width / 2, height));
  if (r <= 0) return `M ${x} ${y} H ${x + width} V ${y + height} H ${x} Z`;
  return `M ${x} ${y + height} V ${y + r} A ${r} ${r} 0 0 1 ${x + r} ${y} H ${x + width - r} A ${r} ${r} 0 0 1 ${x + width} ${y + r} V ${y + height} Z`;
}

// Hit-testing maps every position to the column owning it, so each day's hit
// region is its whole slot including the gap around the bar — the widest
// non-overlapping target the layout allows.
export function dailyBarIndexAt(localX: number, chartWidth: number, dayCount: number) {
  if (dayCount <= 1 || chartWidth <= 0) return 0;
  const slotWidth = chartWidth / dayCount;
  return Math.min(dayCount - 1, Math.max(0, Math.floor(localX / slotWidth)));
}
