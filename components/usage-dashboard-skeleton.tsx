import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ToggleGroupPreview } from "@/components/ui/toggle-group";

// The theme exposes its colors as complete color-mix() values rather than HSL
// channel triplets, so every translucent tone here goes through color-mix too.
// An `hsl(var(--muted) / …)` form parses as invalid and renders nothing.
const SHIMMER_STYLE = `
@keyframes usage-shimmer-sweep {
  from { transform: translateX(-100%); }
  to { transform: translateX(100%); }
}
@keyframes usage-shimmer-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
.usage-shimmer {
  position: relative;
  overflow: hidden;
  background-color: color-mix(in oklch, var(--ink) 26%, var(--canvas));
  animation: usage-shimmer-pulse 1.8s ease-in-out infinite;
}
.usage-shimmer::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in oklch, var(--foreground) 16%, transparent) 50%,
    transparent 100%
  );
  animation: usage-shimmer-sweep 1.8s ease-in-out infinite;
  /* Per-element stagger is set inline on the host and applies to both layers. */
  animation-delay: inherit;
}
@media (prefers-reduced-motion: reduce) {
  .usage-shimmer { animation: none; }
  .usage-shimmer::after { animation: none; background: none; }
}
`;

// Only values shimmer. Every label, heading, and column header the dashboard
// always shows is rendered as its real text, so the layout does not reflow when
// the data arrives and the page reads as itself while it loads.
function Shimmer({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div aria-hidden="true" className={`usage-shimmer rounded-md ${className ?? ""}`} style={style} />;
}

function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className}>{children}</div>;
}

const CARD_CLASSES = "rounded-xl border border-border/70 bg-muted/[0.08]";

function ChartSkeleton({ compactView }: { compactView: boolean }) {
  return (
    <div className="relative w-full overflow-hidden" style={{ height: compactView ? 250 : 322 }}>
      {/* real gridlines with real-looking axis positions; values stay blank */}
      {[0, 25, 50, 75, 100].map((step) => (
        <div
          key={step}
          aria-hidden="true"
          className="absolute inset-x-0 h-px bg-border/70"
          style={{ top: `${step}%` }}
        />
      ))}
      <svg
        viewBox="0 0 400 160"
        preserveAspectRatio="none"
        className="absolute inset-x-0 bottom-0 h-[72%] w-full"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="skeleton-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--muted-foreground)" stopOpacity="0.16" />
            <stop offset="100%" stopColor="var(--muted-foreground)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path
          d="M0 110 C28 98, 54 112, 82 90 C108 70, 132 42, 168 38 C202 34, 228 48, 260 62 C292 76, 318 92, 350 104 L350 160 L0 160 Z"
          fill="url(#skeleton-area)"
        />
        <path
          d="M0 110 C28 98, 54 112, 82 90 C108 70, 132 42, 168 38 C202 34, 228 48, 260 62 C292 76, 318 92, 350 104"
          fill="none"
          stroke="var(--muted-foreground)" strokeOpacity="0.35"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M0 138 C60 136, 140 132, 210 134 C280 136, 330 138, 400 139"
          fill="none"
          stroke="var(--muted-foreground)" strokeOpacity="0.22"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}

function SparklineSkeleton({ seed }: { seed: number }) {
  return (
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="h-8 w-full" aria-hidden="true">
      <path
        d={`M0 ${18 + (seed % 2) * 4} Q 14 ${14 - seed}, 28 ${17 + seed}, 42 ${12 + (seed % 3)}, 62 ${20 - seed}, 82 ${15 + seed}, 100 ${17}`}
        fill="none"
        stroke="var(--muted-foreground)" strokeOpacity="0.3"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

const METRIC_LABELS = ["Processed tokens", "Cached input", "Output", "Cache savings"];

function ProviderRowsSkeleton({ separated = false }: { separated?: boolean }) {
  return (
    <div className={separated ? `overflow-hidden ${CARD_CLASSES}` : "space-y-6"}>
      {[88, 66, 42].map((width, index) => (
        <div
          key={width}
          className={`min-w-0 ${separated ? "border-t border-border/60 px-4 py-3.5 first:border-t-0" : ""}`}
        >
          <div className="flex items-center justify-between gap-4 text-sm">
            <div className="flex min-w-0 items-center gap-2.5 font-medium">
              <Shimmer className="size-5 shrink-0 rounded-[5px]" />
              <Shimmer className="h-3.5 rounded" style={{ width: 96 - index * 12 }} />
            </div>
            <Shimmer className="h-3.5 w-16 shrink-0 rounded" />
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <Shimmer
              className="h-full rounded-full"
              style={{ width: `${width}%`, animationDelay: `${-index * 0.35}s` }}
            />
          </div>
          <Shimmer className="mt-2 h-3 w-40 rounded" />
        </div>
      ))}
    </div>
  );
}

export function UsageDashboardSkeleton() {
  const mainRef = useRef<HTMLElement>(null);
  const [contentWidth, setContentWidth] = useState(0);

  useLayoutEffect(() => {
    const element = mainRef.current;
    if (!element) return;
    const updateWidth = () => setContentWidth(element.clientWidth);
    updateWidth();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const compactView = contentWidth < 640;
  const stackedView = contentWidth < 900;

  return (
    <div role="status" aria-label="Loading usage from all machines" className="h-full overflow-y-auto bg-background">
      <style>{SHIMMER_STYLE}</style>
      <span className="sr-only">Loading usage…</span>
      <main
        ref={mainRef}
        className="mx-auto flex min-h-full w-full max-w-[1440px] flex-col gap-4 px-4 py-3 sm:gap-5 sm:px-5 sm:py-5 md:px-6 lg:gap-8"
      >
        <section
          className={`grid items-stretch ${stackedView ? "gap-4 sm:gap-5" : "gap-10 lg:gap-14"}`}
          style={stackedView ? undefined : { gridTemplateColumns: "minmax(330px, 0.92fr) minmax(0, 1.65fr)" }}
        >
          <div className={stackedView ? `flex min-w-0 flex-col p-4 sm:p-5 ${CARD_CLASSES}` : "relative flex min-w-0 flex-col"}>
            <div className={stackedView ? "flex min-w-0 flex-col" : "absolute inset-0 flex min-w-0 flex-col"}>
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <Label className="text-xs font-medium text-muted-foreground">Raw token cost</Label>
              </div>
              <Shimmer className="mt-2 w-[190px] rounded-lg" style={{ height: compactView ? 40 : 46 }} />
              <Label className="mt-1 text-sm text-muted-foreground">If billed at standard API rates</Label>

              {!stackedView && (
                <div className="mt-7 min-h-0 flex-1 overflow-y-auto pr-3">
                  <ProviderRowsSkeleton />
                </div>
              )}

              {stackedView && (
                <div className="mt-5 min-w-0 border-t border-border/60 pt-4">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
                    <Label className="mr-auto text-sm font-semibold">Daily cost</Label>
                    <ToggleGroupPreview
                      value="cost"
                      options={[{ value: "cost", label: "Cost" }, { value: "tokens", label: "Tokens" }]}
                    />
                  </div>
                  <div className="mt-3">
                    <ChartSkeleton compactView={compactView} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
                    {[58, 74, 68].map((width) => (
                      <div key={width} className="flex items-center gap-1.5">
                        <Shimmer className="size-3.5 shrink-0 rounded-[3px]" />
                        <Shimmer className="h-3 rounded" style={{ width }} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {!stackedView && (
            <div className="flex min-w-0 flex-col">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <Label className="mr-auto text-sm font-semibold">Daily cost</Label>
                <div className="flex flex-wrap items-center gap-2">
                  <ToggleGroupPreview
                    value="agent"
                    options={[{ value: "agent", label: "Agents" }, { value: "provider", label: "Providers" }]}
                  />
                  <ToggleGroupPreview
                    value="cost"
                    options={[{ value: "cost", label: "Cost" }, { value: "tokens", label: "Tokens" }]}
                  />
                </div>
              </div>
              <div className="mt-4">
                <ChartSkeleton compactView={false} />
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
                {[58, 74, 68, 54].map((width) => (
                  <div key={width} className="flex items-center gap-1.5">
                    <Shimmer className="size-3.5 shrink-0 rounded-[3px]" />
                    <Shimmer className="h-3 rounded" style={{ width }} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {stackedView && (
            <div>
              <Label className="mb-2.5 text-sm font-medium text-muted-foreground">Agents</Label>
              <ProviderRowsSkeleton separated />
            </div>
          )}
        </section>

        {/* metric cards: real labels, shimmering values */}
        <section>
          <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-4 sm:snap-none sm:gap-4 sm:overflow-visible sm:px-0 sm:pb-0">
            {METRIC_LABELS.map((label, index) => (
              <div
                key={label}
                className={`flex min-w-[172px] flex-1 shrink-0 snap-start flex-col justify-between gap-3 p-4 sm:min-w-0 sm:p-5 ${CARD_CLASSES}`}
              >
                <div className="min-w-0">
                  <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
                  <Shimmer className="mt-1.5 h-8 w-[88px] rounded" style={{ animationDelay: `${-index * 0.2}s` }} />
                  <Shimmer className="mt-1 h-3 w-[124px] rounded" style={{ animationDelay: `${-index * 0.2}s` }} />
                </div>
                <SparklineSkeleton seed={index} />
              </div>
            ))}
          </div>
        </section>

        {/* breakdown: real heading, real toggle, real column headers */}
        <section>
          <div className="flex items-center justify-between gap-4">
            <Label className="text-sm font-semibold">Breakdown</Label>
            <ToggleGroupPreview
              value="model"
              options={[
                { value: "model", label: "Model" },
                { value: "project", label: "Project" },
                { value: "day", label: "Day" },
              ]}
            />
          </div>

          <div className={`mt-3 overflow-hidden ${CARD_CLASSES}`}>
            {/* wide layouts: the real table header */}
            <table className="hidden w-full border-collapse text-sm sm:table">
              <thead>
                <tr className="border-b border-border bg-muted/20 text-xs text-muted-foreground">
                  <th className="px-4 py-2.5 text-left font-medium">Model</th>
                  <th className="px-4 py-2.5 text-left font-medium">Agent</th>
                  <th className="px-4 py-2.5 text-right font-medium">Cost</th>
                  <th className="px-4 py-2.5 text-right font-medium">Share</th>
                  <th className="px-4 py-2.5 text-right font-medium">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {[0, 1, 2, 3, 4].map((row) => (
                  <tr key={row} className="border-b border-border/60 last:border-0">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Shimmer className="size-[18px] shrink-0 rounded-[4px]" />
                        <Shimmer className="h-3.5 w-40 rounded" style={{ animationDelay: `${-row * 0.18}s` }} />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Shimmer className="size-[18px] shrink-0 rounded-[4px]" />
                        <Shimmer className="h-3.5 w-20 rounded" style={{ animationDelay: `${-row * 0.18}s` }} />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Shimmer className="ml-auto h-3.5 w-16 rounded" style={{ animationDelay: `${-row * 0.18}s` }} />
                    </td>
                    <td className="px-4 py-3">
                      <Shimmer className="ml-auto h-3.5 w-12 rounded" style={{ animationDelay: `${-row * 0.18}s` }} />
                    </td>
                    <td className="px-4 py-3">
                      <Shimmer className="ml-auto h-3.5 w-12 rounded" style={{ animationDelay: `${-row * 0.18}s` }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* narrow layouts: the stacked card rows */}
            <div className="sm:hidden">
              {[0, 1, 2, 3, 4].map((row) => (
                <div key={row} className="border-t border-border/60 px-3.5 py-3 first:border-t-0">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <Shimmer className="size-[18px] shrink-0 rounded-[4px]" />
                      <Shimmer className="h-3.5 w-full max-w-[150px] rounded" style={{ animationDelay: `${-row * 0.18}s` }} />
                    </div>
                    <Shimmer className="h-3.5 w-14 shrink-0 rounded" style={{ animationDelay: `${-row * 0.18}s` }} />
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <Shimmer className="h-[22px] w-24 rounded-md" />
                    <Shimmer className="h-[22px] w-20 rounded-md" />
                    <Shimmer className="ml-auto h-3 w-10 rounded" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
