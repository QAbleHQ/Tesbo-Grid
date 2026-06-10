"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-[14px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_20%,transparent)]",
  {
    variants: {
      variant: {
        default:
          "border border-transparent bg-[var(--brand-primary)] text-white hover:bg-[var(--brand-hover)]",
        destructive:
          "bg-[var(--error)] text-white hover:bg-[color-mix(in_oklab,var(--error)_85%,black)]",
        outline:
          "border border-[var(--glass-border)] bg-[var(--glass-bg)] text-[var(--foreground)] backdrop-blur-md hover:bg-[var(--glass-bg-strong)]",
        secondary:
          "bg-[var(--glass-bg-subtle)] text-[var(--foreground)] backdrop-blur-sm hover:bg-[var(--glass-bg)]",
        ghost:
          "text-[var(--muted)] hover:bg-[var(--glass-bg-subtle)] hover:text-[var(--foreground)]",
        link: "text-[var(--brand-primary)] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 px-5 py-2",
        sm: "h-9 rounded-[10px] px-3.5 text-[13px] font-semibold",
        lg: "h-12 rounded-xl px-6 text-[15px] font-semibold",
        icon: "h-11 w-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
