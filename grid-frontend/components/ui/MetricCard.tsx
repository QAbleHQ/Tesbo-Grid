import type { HTMLAttributes } from "react";
import { cx } from "@/components/ui/cx";

export type MetricCardProps = HTMLAttributes<HTMLDivElement> & {
  label: string;
  value: string | number;
  sub?: string;
  valueColor?: string;
  trend?: { value: string; positive?: boolean };
};

export default function MetricCard({
  label,
  value,
  sub,
  valueColor,
  trend,
  className,
  ...props
}: MetricCardProps) {
  return (
    <div className={cx("tesbo-card px-5 py-4", className)} {...props}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-soft)]">
        {label}
      </p>
      <div className="mt-1 flex items-end gap-2">
        <p
          className="text-2xl font-bold tabular-nums leading-none"
          style={{ color: valueColor || "var(--foreground)" }}
        >
          {value}
        </p>
        {trend && (
          <span
            className={cx(
              "mb-0.5 text-xs font-semibold",
              trend.positive === true && "text-[var(--success)]",
              trend.positive === false && "text-[var(--error)]",
              trend.positive === undefined && "text-[var(--muted)]"
            )}
          >
            {trend.value}
          </span>
        )}
      </div>
      {sub && (
        <p className="mt-1.5 text-xs text-[var(--muted)]">{sub}</p>
      )}
    </div>
  );
}
