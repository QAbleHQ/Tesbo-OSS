"use client";

import { cx } from "@/components/ui/cx";

export type AuthMode = "password" | "otp";

type AuthModeToggleProps = {
  mode: AuthMode;
  onChange: (mode: AuthMode) => void;
  disabled?: boolean;
};

export function AuthModeToggle({ mode, onChange, disabled }: AuthModeToggleProps) {
  return (
    <div className="mb-6 flex rounded-lg bg-white/[0.06] p-[3px]">
      {(
        [
          { value: "password", label: "Password" },
          { value: "otp", label: "Email code" },
        ] as const
      ).map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cx(
            "flex-1 rounded-md py-1.5 text-[12px] font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60",
            mode === option.value
              ? "bg-[var(--cta-primary)] text-white"
              : "text-white/40 hover:text-white/60",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
