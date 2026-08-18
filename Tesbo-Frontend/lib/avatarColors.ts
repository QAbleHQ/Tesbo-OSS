/**
 * The seeded fill palette for avatars, initials and chart series.
 *
 * Every one of these is painted under white text, so each clears WCAG AA (4.5:1) against white.
 * The brighter green (#2D9A52) and amber (#D97C0A) this palette used to carry scored 3.59 and 3.07
 * — and because the swatch is chosen by hashing an id, whether a given user or project hit an
 * unreadable one was luck.
 *
 * Kept in one place: five modules had their own copy of the array, so a correction to one left the
 * other four wrong.
 */
export const AVATAR_COLORS = ["#7C5FCC", "#4C5FD5", "#1F7A3D", "#1D7FA8", "#A85F06", "#D83A3A"];

function hashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** A stable colour for an id — the same seed always gets the same swatch. */
export function avatarColor(seed: string): string {
  return AVATAR_COLORS[hashSeed(seed) % AVATAR_COLORS.length];
}
