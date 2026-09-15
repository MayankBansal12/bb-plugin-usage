import { describe, expect, it } from "vitest";
import {
  BREAKDOWN_DONUT_PALETTE,
  DONUT_TOP_SLICES,
  OTHER_SLICE_COLOR,
  OTHER_SLICE_KEY,
  buildBreakdownDonut,
  type DonutRow,
} from "./breakdown-donut";

function row(key: string, cost: number, tokens: number, unknown = false): DonutRow {
  return { key, label: key, cost, tokens, unknown };
}

describe("buildBreakdownDonut", () => {
  it("keeps every row as its own slice when rows fit the top limit", () => {
    const donut = buildBreakdownDonut([row("a", 30, 3), row("b", 20, 2), row("c", 10, 1)], "cost");
    expect(donut.slices.map((slice) => slice.key)).toEqual(["a", "b", "c"]);
    expect(donut.slices.map((slice) => slice.color)).toEqual(BREAKDOWN_DONUT_PALETTE.slice(0, 3));
    expect(donut.slices[0]!.share).toBeCloseTo(0.5);
    expect(donut.total).toBe(60);
    expect(donut.slices.every((slice) => slice.otherCount === 0)).toBe(true);
  });

  it("folds rows beyond the top limit into a single Other slice", () => {
    const rows = Array.from({ length: DONUT_TOP_SLICES + 3 }, (_, index) => row(`r${index}`, 100 - index, index));
    const donut = buildBreakdownDonut(rows, "cost");
    expect(donut.slices).toHaveLength(DONUT_TOP_SLICES + 1);
    const other = donut.slices.at(-1)!;
    expect(other.key).toBe(OTHER_SLICE_KEY);
    expect(other.label).toBe("Other");
    expect(other.color).toBe(OTHER_SLICE_COLOR);
    expect(other.otherCount).toBe(3);
    expect(other.value).toBe(100 - DONUT_TOP_SLICES + (100 - DONUT_TOP_SLICES - 1) + (100 - DONUT_TOP_SLICES - 2));
    expect(donut.slices.reduce((sum, slice) => sum + slice.share, 0)).toBeCloseTo(1);
  });

  it("ranks by the active metric and breaks ties on the other metric", () => {
    const donut = buildBreakdownDonut([row("low-tokens", 10, 1), row("high-tokens", 10, 9), row("rich", 50, 0)], "cost");
    expect(donut.slices.map((slice) => slice.key)).toEqual(["rich", "high-tokens", "low-tokens"]);
    const tokensDonut = buildBreakdownDonut([row("cheap", 1, 50), row("dear", 9, 10)], "tokens");
    expect(tokensDonut.slices.map((slice) => slice.key)).toEqual(["cheap", "dear"]);
    expect(tokensDonut.slices[0]!.value).toBe(50);
  });

  it("maps every row to its slice color and folded rows to the Other color", () => {
    const rows = Array.from({ length: DONUT_TOP_SLICES + 2 }, (_, index) => row(`r${index}`, 10 - index, 0));
    const donut = buildBreakdownDonut(rows, "cost");
    expect(donut.colorByKey.get("r0")).toBe(BREAKDOWN_DONUT_PALETTE[0]);
    expect(donut.colorByKey.get(`r${DONUT_TOP_SLICES}`)).toBe(OTHER_SLICE_COLOR);
    expect(donut.colorByKey.get(`r${DONUT_TOP_SLICES + 1}`)).toBe(OTHER_SLICE_COLOR);
    expect(donut.colorByKey.size).toBe(rows.length);
  });

  it("drops zero-value rows from slices but keeps their Other-colored dot", () => {
    const donut = buildBreakdownDonut([row("used", 10, 5), row("empty", 0, 0)], "cost");
    expect(donut.slices.map((slice) => slice.key)).toEqual(["used"]);
    expect(donut.slices[0]!.share).toBeCloseTo(1);
    expect(donut.colorByKey.get("empty")).toBe(OTHER_SLICE_COLOR);
  });

  it("counts cost rows with unknown pricing only in cost mode", () => {
    const rows = [row("known", 10, 5), row("mystery", 0, 40, true)];
    const cost = buildBreakdownDonut(rows, "cost");
    expect(cost.unpricedCount).toBe(1);
    expect(cost.slices.map((slice) => slice.key)).toEqual(["known"]);
    const tokens = buildBreakdownDonut(rows, "tokens");
    expect(tokens.unpricedCount).toBe(0);
    expect(tokens.slices.map((slice) => slice.key)).toEqual(["mystery", "known"]);
  });

  it("returns an empty slice list when nothing has value", () => {
    const donut = buildBreakdownDonut([row("a", 0, 0), row("b", 0, 0)], "cost");
    expect(donut.slices).toEqual([]);
    expect(donut.total).toBe(0);
    expect(buildBreakdownDonut([], "tokens").slices).toEqual([]);
  });
});
