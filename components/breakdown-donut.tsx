import { useMemo } from "react";
import type { ReactNode } from "react";
import { OTHER_SLICE_KEY, metricValue, type BreakdownDonutData, type DonutMode, type DonutRow } from "@/lib/breakdown-donut";

const SIZE = 176;
const CENTER = SIZE / 2;
const RADIUS = 64;
const STROKE = 22;
const HOVER_STROKE = 28;
// Segment gap in pathLength-100 units, so a 100% share renders unbroken.
const SLICE_GAP = 0.7;

export function BreakdownDonut({
  donut,
  rows,
  mode,
  groupLabel,
  hoveredKey,
  onHoverKey,
  formatValue,
}: {
  donut: BreakdownDonutData;
  rows: DonutRow[];
  mode: DonutMode;
  groupLabel: string;
  hoveredKey: string | null;
  onHoverKey: (key: string | null) => void;
  formatValue: (value: number) => ReactNode;
}) {
  const rowsByKey = useMemo(() => new Map(rows.map((row) => [row.key, row])), [rows]);
  const hoveredSlice = donut.slices.find((slice) => slice.key === hoveredKey) ?? null;
  const hoveredRow = hoveredKey ? rowsByKey.get(hoveredKey) ?? null : null;
  // Hovering a folded table row highlights the Other slice; the center then
  // shows that row's own numbers rather than the aggregate.
  const activeSliceKey = hoveredSlice ? hoveredSlice.key : hoveredRow ? OTHER_SLICE_KEY : null;
  const center = hoveredSlice ?? (hoveredRow
    ? {
        label: hoveredRow.label,
        value: metricValue(hoveredRow, mode),
        share: donut.total > 0 ? metricValue(hoveredRow, mode) / donut.total : 0,
        otherCount: 0,
      }
    : null);

  let offset = 0;
  return (
    <div className="flex flex-col items-center">
      <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
        <svg
          width={SIZE}
          height={SIZE}
          role="img"
          aria-label={`Share of ${mode} by ${groupLabel}`}
          onPointerLeave={() => onHoverKey(null)}
        >
          {donut.slices.length === 0 ? (
            <circle
              cx={CENTER}
              cy={CENTER}
              r={RADIUS}
              fill="none"
              strokeWidth={STROKE}
              className="stroke-muted/60"
            />
          ) : (
            donut.slices.map((slice) => {
              const length = slice.share * 100;
              const gap = donut.slices.length > 1 && length < 99.9 ? SLICE_GAP : 0;
              const dash = Math.max(0, length - gap);
              const segment = (
                <circle
                  key={slice.key}
                  cx={CENTER}
                  cy={CENTER}
                  r={RADIUS}
                  fill="none"
                  stroke={slice.color}
                  strokeWidth={activeSliceKey === slice.key ? HOVER_STROKE : STROKE}
                  pathLength={100}
                  strokeDasharray={`${dash} ${100 - dash}`}
                  strokeDashoffset={-offset}
                  transform={`rotate(-90 ${CENTER} ${CENTER})`}
                  opacity={activeSliceKey !== null && activeSliceKey !== slice.key ? 0.3 : 1}
                  className="cursor-pointer outline-none transition-[stroke-width,opacity] duration-150 ease-out motion-reduce:transition-none"
                  tabIndex={0}
                  onPointerEnter={() => onHoverKey(slice.key)}
                  onFocus={() => onHoverKey(slice.key)}
                  onBlur={() => onHoverKey(null)}
                >
                  <title>{`${slice.label}${slice.otherCount > 0 ? ` (${slice.otherCount})` : ""} · ${(slice.share * 100).toFixed(1)}%`}</title>
                </circle>
              );
              offset += length;
              return segment;
            })
          )}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
          {center ? (
            <>
              <span className="max-w-full truncate text-[11px] font-medium text-muted-foreground">
                {center.label}{center.otherCount > 0 ? ` (${center.otherCount})` : ""}
              </span>
              <span className="mt-0.5 text-lg font-semibold leading-6 tabular-nums">{formatValue(center.value)}</span>
              <span className="text-[11px] tabular-nums text-muted-foreground">{(center.share * 100).toFixed(1)}%</span>
            </>
          ) : (
            <>
              <span className="text-xl font-semibold leading-7 tabular-nums">{formatValue(donut.total)}</span>
              <span className="mt-0.5 text-[11px] text-muted-foreground">{rows.length} {groupLabel}</span>
            </>
          )}
        </div>
      </div>
      {mode === "cost" && donut.unpricedCount > 0 && (
        <div className="mt-2 max-w-[210px] text-center text-[11px] leading-4 text-muted-foreground">
          {donut.unpricedCount} {groupLabel} with unknown cost not shown
        </div>
      )}
    </div>
  );
}
