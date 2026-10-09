import { describe, expect, it } from "vitest";
import {
  BAR_GAP_RATIO,
  BAR_MIN_WIDTH,
  BAR_SEGMENT_GAP,
  BAR_SLOT_MIN_WIDTH,
  buildDailyBars,
  dailyBarIndexAt,
  dailyBarSize,
  orderStackedSeries,
  roundedTopBarPath,
} from "./daily-bars";

describe("orderStackedSeries", () => {
  it("puts the largest total at the bottom and descends upward", () => {
    const ordered = orderStackedSeries([
      { id: "small", name: "Small", values: [1, 2] },
      { id: "big", name: "Big", values: [10, 10] },
      { id: "mid", name: "Mid", values: [4, 4] },
    ]);
    expect(ordered.map((item) => item.id)).toEqual(["big", "mid", "small"]);
  });

  it("breaks ties by name for a stable order", () => {
    const ordered = orderStackedSeries([
      { id: "b", name: "Beta", values: [5] },
      { id: "a", name: "Alpha", values: [5] },
    ]);
    expect(ordered.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("ignores negative values when ranking", () => {
    const ordered = orderStackedSeries([
      { id: "neg", name: "Neg", values: [-100] },
      { id: "pos", name: "Pos", values: [1] },
    ]);
    expect(ordered.map((item) => item.id)).toEqual(["pos", "neg"]);
  });
});

describe("dailyBarSize", () => {
  it("widens bars for few days and thins them for many", () => {
    const week = dailyBarSize(910, 7);
    const quarter = dailyBarSize(910, 90);
    expect(week.barWidth).toBeGreaterThan(quarter.barWidth);
    expect(week.slotWidth).toBeCloseTo(130);
    expect(week.barWidth).toBeCloseTo(130 / 1.4);
    expect(quarter.barWidth).toBeCloseTo(910 / 90 / 1.4);
  });

  it("keeps the gap at least 40% of the bar width", () => {
    for (const [width, days] of [[910, 7], [910, 30], [910, 90], [300, 30]] as const) {
      const { slotWidth, barWidth } = dailyBarSize(width, days);
      expect(slotWidth - barWidth).toBeGreaterThanOrEqual(barWidth * BAR_GAP_RATIO - 1e-9);
    }
  });

  it("never goes below the minimum bar width while the slot allows it", () => {
    const { barWidth, slotWidth } = dailyBarSize(200, 90);
    expect(slotWidth).toBeLessThan(BAR_MIN_WIDTH * (1 + BAR_GAP_RATIO));
    expect(barWidth).toBe(BAR_MIN_WIDTH);
  });

  it("caps the bar at the slot width for extremely dense charts", () => {
    const { barWidth, slotWidth } = dailyBarSize(100, 90);
    expect(slotWidth).toBeLessThan(BAR_MIN_WIDTH);
    expect(barWidth).toBe(slotWidth);
  });

  it("exposes the minimum slot width callers must preserve", () => {
    expect(BAR_SLOT_MIN_WIDTH).toBeCloseTo(BAR_MIN_WIDTH * (1 + BAR_GAP_RATIO));
  });
});

describe("buildDailyBars", () => {
  const series = [
    { id: "big", name: "Big", values: [6, 0] },
    { id: "small", name: "Small", values: [2, 4] },
  ];
  const layout = buildDailyBars({ dayCount: 2, series, chartWidth: 100, chartHeight: 50, maximum: 8 });

  it("stacks one bar per day in series order", () => {
    expect(layout.columns).toHaveLength(2);
    const [first] = layout.columns;
    expect(first.segments.map((segment) => segment.seriesId)).toEqual(["big", "small"]);
  });

  it("sits the bottom segment on the baseline", () => {
    const [first] = layout.columns;
    const bottom = first.segments[0];
    expect(bottom.y + bottom.height).toBe(50);
  });

  it("leaves a background gap between segments", () => {
    const [first] = layout.columns;
    const [below, above] = first.segments;
    expect(below.y - (above.y + above.height)).toBe(BAR_SEGMENT_GAP);
  });

  it("rounds only the topmost rendered segment", () => {
    const [first, second] = layout.columns;
    expect(first.segments.map((segment) => segment.roundedTop)).toEqual([false, true]);
    expect(second.segments.map((segment) => segment.roundedTop)).toEqual([true]);
  });

  it("does not render zero-usage segments", () => {
    const [, second] = layout.columns;
    expect(second.segments.map((segment) => segment.seriesId)).toEqual(["small"]);
    expect(second.segments[0].y + second.segments[0].height).toBe(50);
  });

  it("centers bars inside their column slots", () => {
    const [first] = layout.columns;
    expect(first.columnX).toBe(0);
    expect(first.columnWidth).toBe(50);
    expect(first.barX).toBeCloseTo((50 - first.barWidth) / 2);
  });

  it("tiles the chart with one full-width hit column per day", () => {
    expect(layout.columns.map((column) => [column.columnX, column.columnX + column.columnWidth])).toEqual([
      [0, 50],
      [50, 100],
    ]);
  });

  it("handles a single day and a single series", () => {
    const single = buildDailyBars({
      dayCount: 1,
      series: [{ id: "only", name: "Only", values: [5] }],
      chartWidth: 200,
      chartHeight: 50,
      maximum: 5,
    });
    expect(single.columns).toHaveLength(1);
    expect(single.columns[0].segments).toHaveLength(1);
    expect(single.columns[0].segments[0]).toMatchObject({ y: 0, height: 50, roundedTop: true });
  });

  it("renders an empty chart without segments", () => {
    const empty = buildDailyBars({ dayCount: 7, series: [], chartWidth: 100, chartHeight: 50, maximum: 1 });
    expect(empty.columns).toHaveLength(7);
    expect(empty.columns.every((column) => column.segments.length === 0)).toBe(true);
  });
});

describe("roundedTopBarPath", () => {
  it("rounds the top corners and leaves the bottom square", () => {
    const path = roundedTopBarPath(10, 5, 20, 40, 4);
    expect(path).toBe("M 10 45 V 9 A 4 4 0 0 1 14 5 H 26 A 4 4 0 0 1 30 9 V 45 Z");
  });

  it("clamps the radius to the segment height", () => {
    const path = roundedTopBarPath(0, 0, 10, 3);
    expect(path).toContain("A 3 3");
  });
});

describe("dailyBarIndexAt", () => {
  it("maps x positions to the owning column", () => {
    expect(dailyBarIndexAt(0, 100, 4)).toBe(0);
    expect(dailyBarIndexAt(24.9, 100, 4)).toBe(0);
    expect(dailyBarIndexAt(25, 100, 4)).toBe(1);
    expect(dailyBarIndexAt(99.9, 100, 4)).toBe(3);
  });

  it("clamps out-of-range positions", () => {
    expect(dailyBarIndexAt(-5, 100, 4)).toBe(0);
    expect(dailyBarIndexAt(500, 100, 4)).toBe(3);
    expect(dailyBarIndexAt(10, 0, 4)).toBe(0);
    expect(dailyBarIndexAt(10, 100, 1)).toBe(0);
  });
});
