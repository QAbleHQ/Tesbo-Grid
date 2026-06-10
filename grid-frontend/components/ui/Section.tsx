import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "@/components/ui/cx";

export type SectionProps = HTMLAttributes<HTMLElement> & {
  title: string;
  action?: ReactNode;
  children?: ReactNode;
};

export function SectionHeader({
  title,
  action,
  className,
}: {
  title: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("mb-3 flex items-center justify-between gap-3", className)}>
      <h2 className="text-base font-semibold text-[var(--foreground)]">{title}</h2>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export default function Section({
  title,
  action,
  className,
  children,
  ...props
}: SectionProps) {
  return (
    <section className={cx("tesbo-section", className)} {...props}>
      <SectionHeader title={title} action={action} />
      {children}
    </section>
  );
}
