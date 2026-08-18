import { pbkdf2Sync, randomBytes } from "node:crypto";

/**
 * Produces a password hash the product will accept, for fixtures that insert users straight into
 * Postgres instead of going through signup.
 *
 * Mirrors Tesbo-Backend-Nest/src/auth/password.service.ts's PasswordService.hashPassword exactly
 * (pbkdf2_sha256, 210000 iterations, 32-byte key). If that format ever changes this has to change
 * with it, or every seeded login starts failing for a reason that looks nothing like the cause.
 *
 * Why seed at all: /api/auth/signup/start is IP rate-limited and every fixture tenant looks like
 * the same caller, so each extra signup spends budget the auth suite's own rate-limit tests need.
 */
export function hashPasswordForSeed(password: string): string {
  const iterations = 210_000;
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  return `pbkdf2_sha256$${iterations}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}
