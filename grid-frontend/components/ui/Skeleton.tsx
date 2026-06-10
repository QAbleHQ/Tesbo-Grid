import { cx } from "@/components/ui/cx";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton", className)} />;
}

export function SkeletonText({ className, width = "w-32" }: { className?: string; width?: string }) {
  return <div className={cx("skeleton skeleton-text", width, className)} />;
}

export function SkeletonCard({ className }: { className?: string }) {
  return <div className={cx("skeleton skeleton-card", className)} />;
}

export function SkeletonMetric({ className }: { className?: string }) {
  return <div className={cx("skeleton skeleton-metric", className)} />;
}

export function PageSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      <div className="space-y-2">
        <SkeletonText width="w-48" className="h-7" />
        <SkeletonText width="w-72" className="h-4" />
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonMetric key={i} />
        ))}
      </div>
      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, i) => (
          <SkeletonCard key={i} className={i > 2 ? "opacity-60" : ""} />
        ))}
      </div>
    </div>
  );
}

export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="tesbo-card overflow-hidden">
      <div className="bg-[var(--glass-bg-subtle)] px-4 py-3 flex gap-4">
        {Array.from({ length: cols }).map((_, i) => (
          <SkeletonText key={i} width={i === 0 ? "w-40" : "w-16"} />
        ))}
      </div>
      <div className="divide-y divide-[var(--border-subtle)]">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="px-4 py-3 flex gap-4" style={{ opacity: 1 - i * 0.12 }}>
            {Array.from({ length: cols }).map((_, j) => (
              <SkeletonText key={j} width={j === 0 ? "w-48" : "w-12"} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
