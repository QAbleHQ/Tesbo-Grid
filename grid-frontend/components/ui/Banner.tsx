import type { ReactNode } from "react";
import { cx } from "@/components/ui/cx";

export type BannerTone = "info" | "success" | "warning" | "error" | "brand" | "ai";

const toneStyles: Record<
  BannerTone,
  { card: string; iconWrap: string; iconColor: string; title: string }
> = {
  info: {
    card: "border-[var(--info-border)] bg-[var(--info-soft)]",
    iconWrap: "bg-[var(--info-soft)]",
    iconColor: "text-[var(--info)]",
    title: "text-[var(--info-foreground)]",
  },
  success: {
    card: "border-[var(--success-border)] bg-[var(--success-soft)]",
    iconWrap: "bg-[var(--success-soft)]",
    iconColor: "text-[var(--success)]",
    title: "text-[var(--success-foreground)]",
  },
  warning: {
    card: "border-[var(--warning-border)] bg-[var(--warning-soft)]",
    iconWrap: "bg-[var(--warning-soft)]",
    iconColor: "text-[var(--warning)]",
    title: "text-[var(--warning-foreground)]",
  },
  error: {
    card: "border-[var(--error-border)] bg-[var(--error-soft)]",
    iconWrap: "bg-[var(--error-soft)]",
    iconColor: "text-[var(--error)]",
    title: "text-[var(--error-foreground)]",
  },
  brand: {
    card: "border-[var(--brand-border)] bg-[var(--brand-soft)]",
    iconWrap: "bg-[var(--brand-soft)]",
    iconColor: "text-[var(--brand-primary)]",
    title: "text-[var(--brand-primary)]",
  },
  ai: {
    card: "border-[var(--ai-border)] bg-[var(--ai-soft)]",
    iconWrap: "bg-[var(--ai-soft)]",
    iconColor: "text-[var(--ai-primary)]",
    title: "text-[var(--ai-primary)]",
  },
};

const defaultIcons: Record<BannerTone, ReactNode> = {
  info: (
    <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
    </svg>
  ),
  success: (
    <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  warning: (
    <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 15.75h.007v.008H12v-.008z" />
    </svg>
  ),
  error: (
    <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9.303 3.376c.866 1.5-.217 3.374-1.948 3.374H4.645c-1.73 0-2.813-1.874-1.948-3.374L10.05 3.378c.866-1.5 3.032-1.5 3.898 0l7.355 12.748z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 15.75h.007v.008H12v-.008z" />
    </svg>
  ),
  brand: (
    <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.040.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
    </svg>
  ),
  ai: (
    <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
    </svg>
  ),
};

export type BannerProps = {
  tone?: BannerTone;
  icon?: ReactNode;
  title?: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  children?: ReactNode;
};

export default function Banner({
  tone = "info",
  icon,
  title,
  description,
  action,
  className,
  children,
}: BannerProps) {
  const styles = toneStyles[tone];
  const displayIcon = icon ?? defaultIcons[tone];

  return (
    <div
      className={cx(
        "tesbo-card flex items-start gap-3.5 border px-5 py-4",
        styles.card,
        className
      )}
    >
      <div className={cx("mt-0.5 shrink-0 rounded-xl p-2", styles.iconWrap, styles.iconColor)}>
        {displayIcon}
      </div>
      <div className="min-w-0 flex-1">
        {title && (
          <p className={cx("text-sm font-semibold", styles.title)}>{title}</p>
        )}
        {description && (
          <p className="mt-0.5 text-sm text-[var(--muted)]">{description}</p>
        )}
        {children}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
