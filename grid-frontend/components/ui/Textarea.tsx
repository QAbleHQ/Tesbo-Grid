import type { TextareaHTMLAttributes } from "react";
import { cx } from "@/components/ui/cx";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export default function Textarea({ className, ...props }: TextareaProps) {
  return (
    <textarea
      className={cx(
        "w-full rounded-xl border border-[var(--glass-border-soft)] bg-[var(--glass-bg-subtle)] px-3.5 py-2.5 text-[15px] text-[var(--foreground)] backdrop-blur-md placeholder:text-[var(--muted-soft)]",
        "shadow-[inset_0_1px_0_var(--glass-highlight)]",
        "transition-[border-color,box-shadow,background-color] duration-150",
        "focus:border-[var(--brand-primary)] focus:bg-[var(--glass-bg)] focus:outline-none focus:ring-4 focus:ring-[color-mix(in_oklab,var(--brand-primary)_18%,transparent)]",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}
