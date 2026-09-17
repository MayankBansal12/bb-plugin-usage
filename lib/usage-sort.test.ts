import { describe, expect, it } from "vitest";
import { compareUsage, nextUsageSort, type UsageSort } from "./usage-sort";

describe("usage sorting", () => {
  const rows = [
    { id: "paid", cost: 10, tokens: 100 },
    { id: "unpriced", cost: 0, tokens: 900, unknown: true },
    { id: "free", cost: 0, tokens: 20 },
    { id: "partial", cost: 2, tokens: 400, unknown: true },
  ];
  const ranked = (sort: UsageSort) => [...rows].sort((a, b) => compareUsage(a, b, sort)).map((row) => row.id);

  it("includes unpriced usage in token rankings", () => {
    expect(ranked({ metric: "tokens", direction: "descending" })).toEqual(["unpriced", "partial", "paid", "free"]);
    expect(ranked({ metric: "tokens", direction: "ascending" })).toEqual(["free", "paid", "partial", "unpriced"]);
  });

  it("distinguishes free from unknown cost in both directions", () => {
    expect(ranked({ metric: "cost", direction: "ascending" })).toEqual(["free", "partial", "paid", "unpriced"]);
    expect(ranked({ metric: "cost", direction: "descending" })).toEqual(["paid", "partial", "free", "unpriced"]);
  });

  it("keeps token volume useful when all costs are unknown", () => {
    const unpriced = rows.map((row) => ({ ...row, cost: 0, unknown: true }));
    for (const direction of ["ascending", "descending"] as const) {
      expect(unpriced.sort((a, b) => compareUsage(a, b, { metric: "cost", direction })).map((row) => row.id))
        .toEqual(["unpriced", "partial", "paid", "free"]);
    }
  });

  it("reverses the active column and starts a new column largest first", () => {
    const initial: UsageSort = { metric: "tokens", direction: "descending" };
    const ascending = nextUsageSort(initial, "tokens");
    expect(ascending).toEqual({ metric: "tokens", direction: "ascending" });
    expect(nextUsageSort(ascending, "tokens")).toEqual(initial);
    expect(nextUsageSort(ascending, "cost")).toEqual({ metric: "cost", direction: "descending" });
  });
});
