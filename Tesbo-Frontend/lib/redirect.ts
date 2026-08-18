/**
 * The `?redirect=` parameter on /login, and the two ways it can turn against the user.
 *
 * 1. It is caller-supplied text that ends up inside `router.replace()`. Browsers read both
 *    `//host` and `/\host` as protocol-relative URLs, so a crafted link to
 *    `/login?redirect=//evil.example` walks a signed-in user straight off the product. Only a path
 *    rooted at a single slash is ever honoured.
 *
 * 2. The destination can send the user back to /login, which then sends them onward again. That is
 *    not hypothetical: an edge rule on app-stage.tesbo.io answers every authenticated route with
 *    307 → `/login?redirect=<path>` unless a `tesbo_session` cookie is present on the *frontend*
 *    host, and it never is — the backend sets that cookie with no Domain attribute, so it belongs
 *    to the API host alone. `authMe()` reaches the API cross-origin with credentials and does see
 *    the session, so the app reads the user as signed in while the edge cannot, and the two bounce
 *    the user between each other for as long as the tab stays open.
 *
 *    /login is the only participant able to break that cycle, because it is the half that keeps
 *    choosing to leave. It cannot tell *why* the destination refused it, and does not need to: one
 *    bounce is proof that redirecting a second time will not help.
 */

/** Where an in-flight redirect was aimed, remembered across the bounce a loop is made of. */
const ATTEMPT_KEY = "tesbo_login_redirect_attempt";

/*
 * A bounce turns over in about two seconds — the recorded session managed two full cycles inside
 * seventeen. Treating anything slower as a fresh, deliberate visit means a loop that has ended
 * cannot keep punishing later sign-ins, and no code path has to remember to clear the marker.
 */
const ATTEMPT_TTL_MS = 10_000;

type Attempt = { target: string; at: number };

/*
 * sessionStorage, not a module-level variable: the marker has to outlive the component (the loop
 * unmounts /login on the way out and mounts it again on the way back) but must not outlive the tab,
 * or a loop in one tab would block a second tab where the user is doing something else. Every
 * access is guarded because a browser refusing site data throws on *access*, not just on write.
 */
function readAttempt(): Attempt | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(ATTEMPT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { target, at } = parsed as Partial<Attempt>;
    if (typeof target !== "string" || typeof at !== "number") return null;
    return { target, at };
  } catch {
    // Storage refused, or something left an unparseable value behind. Either way there is no known
    // attempt, so the caller redirects — exactly the behaviour that existed before this guard.
    return null;
  }
}

/**
 * A path on this origin, or `null` for anything the router must not be handed.
 *
 * Rejects `/login` itself as well: a redirect back to the page doing the redirecting is never what
 * the caller meant, and honouring it is its own small loop.
 */
export function safeRedirectPath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value.startsWith("/")) return null;
  // Protocol-relative in both spellings — a browser resolves `/\host` the same as `//host`.
  if (value.startsWith("//") || value.startsWith("/\\")) return null;
  // A control character (newline, tab, NUL) can smuggle either of the above past a prefix check.
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  const [path] = value.split(/[?#]/, 1);
  if (path === "/login") return null;
  return value;
}

/** True when we already sent the user to `target` and they came straight back. */
export function isRedirectBounce(target: string): boolean {
  const attempt = readAttempt();
  if (!attempt || attempt.target !== target) return false;
  return Date.now() - attempt.at < ATTEMPT_TTL_MS;
}

export function noteRedirectAttempt(target: string): void {
  if (typeof window === "undefined") return;
  try {
    const attempt: Attempt = { target, at: Date.now() };
    window.sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify(attempt));
  } catch {
    // Without the marker the loop guard is inert and /login behaves as it did before. The redirect
    // this accompanies still happens, so a working destination is unaffected.
  }
}

export function clearRedirectAttempts(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(ATTEMPT_KEY);
  } catch {
    // Nothing was readable to begin with.
  }
}
