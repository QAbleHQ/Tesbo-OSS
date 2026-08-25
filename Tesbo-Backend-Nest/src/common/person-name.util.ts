import { BadRequestException } from "@nestjs/common";

const MAX_LENGTH = 100;
// Unicode letters/marks (so accented and non-Latin names aren't rejected) plus the
// punctuation real names actually use: space, hyphen, apostrophe, period (e.g. "Jr.").
const ALLOWED_CHARS_RE = /^[\p{L}\p{M} '.-]+$/u;

/**
 * Shared by every signup/registration path that collects a person's name (first, last, or full).
 * `maxLength` defaults to the shared 100-char cap; self-serve signup's first/last name fields pass
 * a stricter 50 explicitly (see SignupService.startSelfServeSignup) without affecting every other
 * caller, which still validates a single combined "Name" field against the default.
 */
export function validatePersonName(raw: string | undefined, fieldLabel = "Name", maxLength = MAX_LENGTH): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) throw new BadRequestException({ error: `${fieldLabel} is required` });
  if (trimmed.length > maxLength) {
    throw new BadRequestException({ error: `${fieldLabel} must be at most ${maxLength} characters` });
  }
  if (!ALLOWED_CHARS_RE.test(trimmed)) {
    throw new BadRequestException({
      error: `${fieldLabel} can only contain letters, spaces, hyphens, apostrophes, and periods`
    });
  }
  return trimmed;
}
