/**
 * localStorage that cannot take the app down.
 *
 * Every localStorage member throws — not just on quota, but on *access* — when a browser refuses
 * site data: Safari private browsing, a locked-down enterprise profile, third-party-cookie blocking
 * in an embedded context. Everything we keep there is a convenience (a remembered panel state, a
 * view toggle, a cached token), so a browser that refuses storage should cost the user that
 * convenience, not the product: an unguarded read during render escapes to Next's client-side
 * exception screen and nothing loads at all.
 *
 * Also guards `typeof window`, so these are safe to call from code that runs on the server.
 */

export function readStoredValue(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStoredValue(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The preference simply isn't remembered. The action it accompanies still happened.
  }
}

export function removeStoredValue(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing was stored to begin with in a browser that refuses storage.
  }
}
