import type { HTMLAttributes } from "react";
import { cx } from "@/components/ui/cx";

type CardVariant = "glass" | "glass-strong" | "solid";

const variantClasses: Record<CardVariant, string> = {
  glass: "tesbo-card",
  "glass-strong": "tesbo-card-elevated",
  solid:
    "rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--surface)] shadow-[var(--shadow-card)]",
};

type CardProps = HTMLAttributes<HTMLDivElement> & { variant?: CardVariant };

export function Card({ className, variant = "glass", ...props }: CardProps) {
  return <div className={cx(variantClasses[variant], className)} {...props} />;
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("mb-4 flex items-start justify-between gap-3", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cx("text-[18px] font-semibold leading-6 text-[var(--foreground)]", className)} {...props} />;
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("text-[14px] leading-6 text-[var(--muted)]", className)} {...props} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("mt-4 flex items-center gap-2", className)} {...props} />;
}
