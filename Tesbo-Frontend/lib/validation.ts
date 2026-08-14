// Mirrors the backend rules in Tesbo-Backend-Nest/src/common/person-name.util.ts and
// Tesbo-Backend-Nest/src/auth/password.service.ts (assertValidPassword) — keep both in sync.

export const NAME_MAX_LENGTH = 100;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const EMAIL_MAX_LENGTH = 255;

export const PASSWORD_RULES_HINT = `At least ${PASSWORD_MIN_LENGTH} characters, with an uppercase letter, a lowercase letter, and a number.`;

// Unicode letters/marks so accented and non-Latin names aren't rejected, plus the
// punctuation real names use: space, hyphen, apostrophe, period (e.g. "Jr.").
const NAME_CHARS_RE = /^[\p{L}\p{M} '.-]+$/u;

export function validateName(value: string, fieldLabel = "Name"): string | null {
  const trimmed = value.trim();
  if (!trimmed) return `${fieldLabel} is required`;
  if (trimmed.length > NAME_MAX_LENGTH) return `${fieldLabel} must be at most ${NAME_MAX_LENGTH} characters`;
  if (!NAME_CHARS_RE.test(trimmed)) {
    return `${fieldLabel} can only contain letters, spaces, hyphens, apostrophes, and periods`;
  }
  return null;
}

export function validatePasswordValue(value: string): string | null {
  if (value.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (value.length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  if (!/[a-z]/.test(value)) return "Password must include at least one lowercase letter";
  if (!/[A-Z]/.test(value)) return "Password must include at least one uppercase letter";
  if (!/[0-9]/.test(value)) return "Password must include at least one number";
  return null;
}

export function validateEmailValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Email is required";
  if (trimmed.length > EMAIL_MAX_LENGTH) return `Email must be at most ${EMAIL_MAX_LENGTH} characters`;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return "Enter a valid email address";
  return null;
}
