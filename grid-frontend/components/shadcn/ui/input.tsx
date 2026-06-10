import * as React from "react";
import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-11 w-full rounded-xl border border-[var(--glass-border-soft)] bg-[var(--glass-bg-subtle)] px-3.5 py-1 text-[15px] text-[var(--foreground)] backdrop-blur-md shadow-[inset_0_1px_0_var(--glass-highlight)] transition-[border-color,box-shadow,background-color] duration-150 file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-[var(--muted-soft)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_18%,transparent)] focus-visible:border-[var(--brand-primary)] focus-visible:bg-[var(--glass-bg)] disabled:cursor-not-allowed disabled:opacity-60",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

export { Input };
