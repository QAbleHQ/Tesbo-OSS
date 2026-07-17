"use client";

import { useRef } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";

type OtpBoxInputProps = {
  value: string;
  onChange: (value: string) => void;
  length?: number;
  disabled?: boolean;
  autoFocus?: boolean;
};

export function OtpBoxInput({ value, onChange, length = 6, disabled, autoFocus }: OtpBoxInputProps) {
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);

  function setDigitAt(index: number, digit: string) {
    const chars = Array.from({ length }, (_, i) => value[i] ?? "");
    chars[index] = digit;
    onChange(chars.join("").replace(/\s+$/, ""));
  }

  function handleChange(index: number, raw: string) {
    const digit = raw.replace(/\D/g, "").slice(-1);
    setDigitAt(index, digit);
    if (digit && index < length - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  }

  function handleKeyDown(index: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !value[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
      setDigitAt(index - 1, "");
    } else if (e.key === "ArrowLeft" && index > 0) {
      inputRefs.current[index - 1]?.focus();
    } else if (e.key === "ArrowRight" && index < length - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, length);
    if (!pasted) return;
    e.preventDefault();
    onChange(pasted);
    const focusIndex = Math.min(pasted.length, length - 1);
    inputRefs.current[focusIndex]?.focus();
  }

  return (
    <div className="flex justify-center gap-2">
      {Array.from({ length }).map((_, index) => (
        <input
          key={index}
          ref={(el) => {
            inputRefs.current[index] = el;
          }}
          type="text"
          inputMode="numeric"
          maxLength={1}
          autoFocus={autoFocus && index === 0}
          disabled={disabled}
          value={value[index] ?? ""}
          onChange={(e) => handleChange(index, e.target.value)}
          onKeyDown={(e) => handleKeyDown(index, e)}
          onPaste={handlePaste}
          className="h-12 w-[42px] rounded-lg border border-[var(--border)] bg-[var(--surface)] text-center font-mono text-[20px] font-bold text-[var(--foreground)] outline-none transition-colors duration-150 focus:border-[var(--denim-200)] disabled:cursor-not-allowed disabled:opacity-60"
        />
      ))}
    </div>
  );
}
