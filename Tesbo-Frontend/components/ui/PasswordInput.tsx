"use client";

import { forwardRef, useState } from "react";
import { IconEye, IconEyeOff } from "@tabler/icons-react";
import { cx } from "@/components/ui/cx";
import type { InputProps } from "@/components/ui/Input";

const PasswordInput = forwardRef<HTMLInputElement, InputProps>(function PasswordInput(
  { className, ...props },
  ref,
) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <input
        ref={ref}
        type={visible ? "text" : "password"}
        className={cx(
          "h-9 w-full rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface)] px-3 pr-9 text-[14px] text-[var(--foreground)] placeholder:text-[var(--ink-300)]",
          "transition-[border-color,box-shadow,background-color] duration-150",
          "focus:border-[var(--denim-200)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_oklab,var(--denim-200)_22%,transparent)]",
          "disabled:cursor-not-allowed disabled:opacity-60",
          className,
        )}
        {...props}
      />
      <button
        type="button"
        onClick={() => setVisible((value) => !value)}
        tabIndex={-1}
        aria-label={visible ? "Hide password" : "Show password"}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--ink-300)] transition-colors hover:text-[var(--muted)]"
      >
        {visible ? <IconEyeOff size={16} stroke={1.6} /> : <IconEye size={16} stroke={1.6} />}
      </button>
    </div>
  );
});

export default PasswordInput;
