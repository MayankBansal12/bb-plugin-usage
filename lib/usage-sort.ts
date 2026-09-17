export type MetricMode = "cost" | "tokens";
export type UsageSort = { metric: MetricMode; direction: "ascending" | "descending" };
type UsageValue = { cost: number; tokens: number; unknown?: boolean };

export function nextUsageSort(current: UsageSort, metric: MetricMode): UsageSort {
  return {
    metric,
    direction: current.metric === metric && current.direction === "descending" ? "ascending" : "descending",
  };
}

export function compareUsage(a: UsageValue, b: UsageValue, sort: UsageSort): number {
  // An unknown cost is not a zero-dollar cost. Keep it after known values in
  // either direction, while still allowing its tokens to sort normally.
  if (sort.metric === "cost") {
    const aUnknown = Boolean(a.unknown && a.cost === 0);
    const bUnknown = Boolean(b.unknown && b.cost === 0);
    if (aUnknown !== bUnknown) return aUnknown ? 1 : -1;
  }
  const otherMetric = sort.metric === "cost" ? "tokens" : "cost";
  const difference = a[sort.metric] - b[sort.metric];
  // Equal primary values keep the larger secondary value first in either
  // direction, so reversing a sort does not shuffle ties unnecessarily.
  return (sort.direction === "ascending" ? difference : -difference) || b[otherMetric] - a[otherMetric];
}
