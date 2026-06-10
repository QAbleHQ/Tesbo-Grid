import type { ReactNode } from "react";
import { cx } from "@/components/ui/cx";
import Button from "@/components/ui/Button";

type ErrorBlockProps = {
  title?: string;
  message: string;
  retry?: () => void;
  icon?: ReactNode;
  className?: string;
};

export default function ErrorBlock({
  title = "Something went wrong",
  message,
  retry,
  icon,
  className,
}: ErrorBlockProps) {
  return (
    <div className={cx("tesbo-card border-[var(--error-border)] p-8 text-center", className)}>
      {icon ? (
        <div className="mx-auto mb-3 inline-flex rounded-xl bg-[var(--error-soft)] p-3 text-[var(--error)]">
          {icon}
        </div>
      ) : (
        <div className="mx-auto mb-3 inline-flex rounded-xl bg-[var(--error-soft)] p-3 text-[var(--error)]">
          <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126Z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 15.75h.007v.008H12v-.008Z" />
          </svg>
        </div>
      )}
      <p className="text-base font-semibold text-[var(--foreground)]">{title}</p>
      <p className="mt-1.5 text-sm text-[var(--muted)]">{message}</p>
      {retry && (
        <Button
          variant="glass"
          size="sm"
          onClick={retry}
          className="mt-4 gap-1.5"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
          </svg>
          Retry
        </Button>
      )}
    </div>
  );
}
