function ShimmerBlock({ className }: { className: string }) {
  return <div className={`animate-pulse rounded-md bg-muted/70 ${className}`} />;
}

export function UsageDashboardSkeleton() {
  return (
    <div className="h-full overflow-auto" role="status" aria-label="Loading usage from all machines">
      <span className="sr-only">Collecting usage from all connected machines…</span>
      <main className="mx-auto w-full max-w-[1440px] px-4 pb-6 pt-5 sm:px-6">
        <div className="flex items-center justify-between gap-4 border-b border-border/70 pb-5">
          <div className="space-y-2">
            <ShimmerBlock className="h-3 w-28" />
            <ShimmerBlock className="h-4 w-56 max-w-[65vw]" />
          </div>
          <ShimmerBlock className="h-8 w-28" />
        </div>

        <section className="grid gap-8 py-6 md:grid-cols-[minmax(250px,0.72fr)_minmax(0,1.8fr)]">
          <div className="space-y-4">
            <ShimmerBlock className="h-3 w-24" />
            <ShimmerBlock className="h-11 w-44" />
            <ShimmerBlock className="h-4 w-52" />
            <div className="space-y-5 pt-3">
              {[0, 1, 2].map((item) => (
                <div key={item} className="space-y-2">
                  <div className="flex justify-between gap-4">
                    <ShimmerBlock className="h-4 w-24" />
                    <ShimmerBlock className="h-4 w-16" />
                  </div>
                  <ShimmerBlock className="h-1 w-full" />
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-4">
            <div className="flex justify-between gap-4">
              <ShimmerBlock className="h-4 w-28" />
              <ShimmerBlock className="h-7 w-32" />
            </div>
            <ShimmerBlock className="h-64 w-full rounded-xl" />
          </div>
        </section>

        <section className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border/70 bg-border/70 sm:grid-cols-3 lg:grid-cols-5">
          {[0, 1, 2, 3, 4].map((item) => (
            <div key={item} className="space-y-3 bg-background p-5">
              <ShimmerBlock className="h-3 w-20" />
              <ShimmerBlock className="h-7 w-24" />
              <ShimmerBlock className="h-3 w-28 max-w-full" />
            </div>
          ))}
        </section>

        <section className="space-y-4 py-6">
          <div className="flex justify-between gap-4">
            <ShimmerBlock className="h-5 w-24" />
            <ShimmerBlock className="h-7 w-32" />
          </div>
          {[0, 1, 2, 3].map((item) => (
            <ShimmerBlock key={item} className="h-10 w-full" />
          ))}
        </section>
      </main>
    </div>
  );
}
