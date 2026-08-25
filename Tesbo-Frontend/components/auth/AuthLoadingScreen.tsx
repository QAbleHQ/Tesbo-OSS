/**
 * Shared full-screen loading state for the pre-auth flow (login, signup,
 * verify-otp, reset-password) — was duplicated verbatim in three page files.
 * Dark-themed to match AuthSplitShell's branding panel; uses the same ring
 * spinner as the in-app PageLoader (components/ui/PageLoader.tsx) so the
 * platform has one loading look, signed in or not.
 */
export function AuthLoadingScreen() {
  return (
    <div
      className="dark flex min-h-screen flex-col items-center justify-center gap-3 bg-[#0d0d1a]"
      style={{ colorScheme: "dark" }}
    >
      <div role="status" aria-live="polite" className="flex flex-col items-center gap-3">
        <div
          aria-hidden="true"
          className="h-8 w-8 animate-spin rounded-full border-2 border-white/40 border-t-transparent"
        />
        <p className="text-sm text-white/40">Loading…</p>
      </div>
    </div>
  );
}
