"use client";

import React from "react";

export interface SelectorGroupOption<T extends string> {
  id: T;
  label: string;
  description?: string;
  disabled?: boolean;
  tooltip?: string;
}

export interface SelectorGroupProps<T extends string> {
  label: string;
  options: SelectorGroupOption<T>[];
  value: T;
  onChange: (v: T) => void;
}

export default function SelectorGroup<T extends string>({
  label,
  options,
  value,
  onChange,
}: SelectorGroupProps<T>) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wide">
        {label}
      </p>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const active = value === opt.id;
          const disabled = opt.disabled;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => !disabled && onChange(opt.id)}
              disabled={disabled}
              aria-pressed={active}
              title={opt.tooltip}
              className={`rounded-xl border px-4 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--brand-primary)_30%,transparent)] ${
                disabled
                  ? "cursor-not-allowed border-[var(--glass-border-soft)] bg-[var(--glass-bg-subtle)] text-[var(--muted)] opacity-60"
                  : active
                  ? "border-[var(--brand-primary)] bg-[var(--brand-soft)] text-[var(--brand-primary)] shadow-[inset_0_1px_0_var(--glass-highlight)]"
                  : "border-[var(--glass-border-soft)] bg-[var(--glass-bg-subtle)] text-[var(--foreground)] backdrop-blur-sm hover:border-[var(--glass-border)] hover:bg-[var(--glass-bg)]"
              }`}
            >
              <span className="text-sm font-medium">{opt.label}</span>
              {opt.description && (
                <span
                  className={`block text-[11px] mt-0.5 ${
                    active
                      ? "text-[color-mix(in_oklab,var(--brand-primary)_70%,transparent)]"
                      : "text-[var(--muted)]"
                  }`}
                >
                  {opt.description}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
