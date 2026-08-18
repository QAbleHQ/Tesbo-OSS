"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Generic dropdown menu shared by the folder tree's per-node menu and the item table's
// row-action menu. Renders through a portal at a fixed (viewport-relative) position computed
// from the trigger's bounding rect, so the menu is never clipped by an ancestor with
// `overflow-x` set (e.g. the content table's horizontal scroll wrapper).

export function Menu({
  trigger,
  children,
  align = "left",
}: {
  trigger: React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function updatePosition() {
      if (!triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
      setPosition({ top: rect.bottom + 4, left: align === "right" ? rect.right : rect.left });
    }
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, align]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <div className="inline-block" ref={triggerRef}>
      <div
        role="button"
        tabIndex={0}
        onClick={(e) => {
          // Stop here so a trigger nested in a clickable row (e.g. a folder-tree node) never
          // needs its own stopPropagation to keep this click from also selecting the row —
          // and, more importantly, so it can't accidentally swallow this handler's own toggle.
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        {trigger}
      </div>
      {open && position && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              style={{
                position: "fixed",
                top: position.top,
                left: position.left,
                transform: align === "right" ? "translateX(-100%)" : undefined,
              }}
              className="z-50 min-w-[180px] rounded-[8px] border border-[var(--border)] bg-[var(--surface-overlay)] py-1 shadow-[var(--shadow-elevated)]"
            >
              {children(() => setOpen(false))}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

export function MenuItem({ onClick, danger, children }: { onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors ${
        danger ? "text-[var(--error-foreground)] hover:bg-[var(--error-soft)]" : "text-[var(--foreground)] hover:bg-[var(--surface-secondary)]"
      }`}
    >
      {children}
    </button>
  );
}
