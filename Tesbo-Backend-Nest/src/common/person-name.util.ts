import { BadRequestException } from "@nestjs/common";

const MAX_LENGTH = 100;
// Unicode letters/marks (so accented and non-Latin names aren't rejected) plus the
// punctuation real names actually use: space, hyphen, apostrophe, period (e.g. "Jr.").
const ALLOWED_CHARS_RE = /^[\p{L}\p{M} '.-]+$/u;

/** Shared by every signup/registration path that collects a person's name (first, last, or full). */
export function validatePersonName(raw: string | undefined, fieldLabel = "Name"): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) throw new BadRequestException({ error: `${fieldLabel} is required` });
  if (trimmed.length > MAX_LENGTH) {
    throw new BadRequestException({ error: `${fieldLabel} must be at most ${MAX_LENGTH} characters` });
  }
  if (!ALLOWED_CHARS_RE.test(trimmed)) {
    throw new BadRequestException({
      error: `${fieldLabel} can only contain letters, spaces, hyphens, apostrophes, and periods`
    });
  }
  return trimmed;
}
