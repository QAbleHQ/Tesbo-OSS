import { cx } from "@/components/ui/cx";

export interface PageLoaderProps {
  /** Shown under the spinner and announced to screen readers. */
  label?: string;
  /**
   * "content" (default) fills the space inside the app shell where a page's own
   * content renders. "screen" takes the full viewport, for standalone screens
   * rendered outside the sidebar/topbar shell (auth, setup, onboarding).
   * "inline" adds no sizing of its own — use it inside an existing bordered
   * panel/flex region (e.g. a `flex-1` split-pane) and size it via `className`.
   */
  variant?: "content" | "screen" | "inline";
  className?: string;
}

/**
 * The one loading state every route should render, in place of each page
 * pairing its own copy of this same ring spinner with its own wrapper
 * div and its own wording. The markup below is exactly what was already
 * duplicated across the app (dashboard, settings, plans, …) — this just
 * gives every other page, and the ones that had no spinner at all, the same
 * one instead of inventing a new look.
 */
export function PageLoader({ label = "Loading…", variant = "content", className }: PageLoaderProps) {
  return (
    <div
      className={cx(
        "flex items-center justify-center",
        // min-h in vh (not a fixed px box) so this stays centered in the middle of
        // the visible screen at any viewport size, header or no header above it.
        // "inline" skips sizing entirely — the caller's className supplies it.
        variant === "screen" && "min-h-screen w-full",
        variant === "content" && "min-h-[70vh] w-full",
        className,
      )}
    >
      <div role="status" aria-live="polite" className="flex flex-col items-center gap-3 px-4 text-center">
        <div
          aria-hidden="true"
          className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--brand-primary)] border-t-transparent"
        />
        <p className="text-[13px] text-[var(--muted)]">{label}</p>
      </div>
    </div>
  );
}
