"use client";

import { useEffect, useState } from "react";
import { IconBell, IconSearch } from "@tabler/icons-react";
import { authMe } from "@/lib/api";
import { useTopBarSlots } from "@/components/TopBarSlots";

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "U";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

export default function TopBar() {
  const [user, setUser] = useState<{ name: string | null; email: string | null } | null>(null);
  const { bindStart, bindEnd, filled } = useTopBarSlots();

  useEffect(() => {
    let active = true;
    authMe().then((me) => {
      if (active && me) setUser({ name: me.name, email: me.email });
    });
    return () => {
      active = false;
    };
  }, []);

  const displayName = user?.name || user?.email || "";

  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-4 border-b border-[var(--border-subtle)] bg-[var(--surface)] px-8">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {/* Page-provided start slot (e.g. breadcrumb). Fills via a portal from the page. */}
        <div ref={bindStart} className="flex min-w-0 items-center" />
        {/* Default global search — only when no page has taken over the top bar. */}
        {!filled && (
          <label className="flex h-8 w-[260px] items-center gap-1.5 rounded-[6px] border border-[var(--border)] bg-[var(--background)] px-2.5 text-[13px] text-[var(--muted-soft)] transition-colors focus-within:border-[var(--brand-primary)]">
            <IconSearch size={14} stroke={1.75} className="shrink-0" />
            <input
              type="text"
              placeholder="Search projects…"
              className="min-w-0 flex-1 bg-transparent text-[var(--foreground)] outline-none placeholder:text-[var(--muted-soft)]"
            />
            <span className="shrink-0 rounded-[3px] bg-[var(--surface-secondary)] px-1 py-0.5 font-mono text-[11px] text-[var(--muted-soft)]">
              ⌘K
            </span>
          </label>
        )}
      </div>
      <div className="flex items-center gap-2">
        {/* Page-provided end slot (e.g. page actions). Fills via a portal from the page. */}
        <div ref={bindEnd} className="flex items-center gap-2 empty:hidden" />
        <button
          type="button"
          aria-label="Notifications"
          className="flex h-8 w-8 items-center justify-center rounded-[6px] border border-[var(--border)] text-[var(--muted-soft)] transition-colors hover:bg-[var(--surface-secondary)]"
        >
          <IconBell size={16} stroke={1.75} />
        </button>
        <span
          title={displayName || undefined}
          className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full bg-[var(--cta-primary)] text-[11px] font-semibold text-white"
        >
          {displayName ? getInitials(displayName) : ""}
        </span>
      </div>
    </header>
  );
}
