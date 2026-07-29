export const DEFAULT_PRODUCT_NAME = "Tesbo Test Manager";
export const DEFAULT_LOGO_URL = "/brand/tesbo-logo-horizontal.svg";

/** Logo the platform shipped with before the brand refresh; still stored on older workspaces. */
const LEGACY_LOGO_URL = "/tesbo-test-manager-logo.png";

/**
 * True when nothing custom has been uploaded, so we can render the built-in
 * lockup — which swaps light/dark variants and has a square mark to fall back on.
 */
export function isBuiltInLogo(logoUrl: string | null | undefined): boolean {
  return !logoUrl || logoUrl === DEFAULT_LOGO_URL || logoUrl === LEGACY_LOGO_URL;
}
