"use client";

import type { ReactNode } from "react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { cx } from "@/components/ui/cx";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
};

export default function Modal({ open, onClose, title, children, className }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  /*
   * The app shell scrolls `main`, not `body`. A portaled overlay does not sit inside that
   * element, so wheel events over the dialog chained to the bugs list behind it. Lock every
   * scroller for the open duration and put overflow on the dialog itself.
   */
  useEffect(() => {
    if (!open) return;
    const html = document.documentElement;
    const main = document.querySelector("main");
    const prev = {
      html: html.style.overflow,
      body: document.body.style.overflow,
      main: main instanceof HTMLElement ? main.style.overflow : "",
    };
    html.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    if (main instanceof HTMLElement) main.style.overflow = "hidden";
    return () => {
      html.style.overflow = prev.html;
      document.body.style.overflow = prev.body;
      if (main instanceof HTMLElement) main.style.overflow = prev.main;
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--overlay-backdrop)] p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="presentation"
        className={cx(
          "flex max-h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface-overlay)] shadow-[var(--shadow-elevated)]",
          className === undefined ? "max-w-[560px]" : className,
        )}
        onClick={(event) => event.stopPropagation()}
      >
        {title ? (
          <h2 className="mb-0 shrink-0 px-6 pt-6 text-[24px] font-semibold leading-[1.2] tracking-[-0.02em] text-[var(--ink-800)]">{title}</h2>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-6 pt-4">
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}
