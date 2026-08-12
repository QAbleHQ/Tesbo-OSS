import { createHash } from "node:crypto";
import { testAddress } from "./env";
import { exec } from "./psql";

// Mirrors Tesbo-Backend-Nest/src/auth/otp.service.ts's OtpService.hash exactly
// (sha256, base64url) — if that ever changes, this needs to change with it.
function hashOtpCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("base64url");
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

// Delegates to utils/psql.ts rather than shelling out again: that module passes the SQL as argv
// instead of piping it into `docker compose exec -T`, which is the only form that survives several
// Playwright workers running at once. A second, stdin-based transport here would keep the
// silently-dropped-statement failure mode alive for OTP fixtures alone.
function psql(sql: string): void {
  exec(sql);
}

// Bypasses OTP delivery entirely by inserting a known code straight into Postgres — the same
// technique global-setup.ts uses to seed a known password hash. Preferred over reading the code
// back from anywhere: it's deterministic, it can't race a concurrent worker's log line, and it
// works whatever POSTMARK_API_TOKEN is set to (blank → the code is console.logged; a real token →
// it leaves as email no spec can read). `expiresInMinutes` can be negative to seed an
// already-expired code.
export function seedOtpCode(email: string, code: string, expiresInMinutes = 10): void {
  const normalizedEmail = escapeSql(email.trim().toLowerCase());
  const codeHash = hashOtpCode(code);
  psql(
    `INSERT INTO otp_codes (email, code_hash, expires_at) VALUES ` +
      `('${normalizedEmail}', '${codeHash}', now() + interval '${expiresInMinutes} minutes');`,
  );
}

/*
 * otp_rate_limit is keyed by ACTION-PREFIXED bucket, not by bare email: OtpService writes
 * `send:<email>` / `send:ip:<address>` on a code request and `verify:<email>` /
 * `verify:ip:<address>` on a failed guess (see the sendLimitKey/verifyLimitKey pair in
 * Tesbo-Backend-Nest/src/auth/otp.service.ts). Both helpers below MUST match those prefixes —
 * an unprefixed `WHERE email = ...` or `LIKE 'ip:%'` silently matches zero rows and the
 * counter it was supposed to reset keeps climbing until the bucket locks for good.
 * The bare-key variants are still cleared to sweep up rows written before that split.
 */

// Every OTP-touching test in this run looks like the same caller IP to the backend, so the
// ip: buckets are genuinely shared and safe to reset — but a blanket `DELETE FROM
// otp_rate_limit` would also wipe a concurrently-running test's own per-email counter (e.g.
// the dedicated rate-limit test's disposable email mid-loop), racily resetting its progress.
// Only ever clear the ip: rows here; use clearOtpRateLimit(email) for a specific email.
export function clearOtpIpRateLimit(): void {
  psql(
    "DELETE FROM otp_rate_limit WHERE email LIKE 'send:ip:%' OR email LIKE 'verify:ip:%' " +
      "OR email LIKE 'ip:%';",
  );
}

// Clears the rate-limit counters for one specific, known email (e.g. the shared
// smoke-test account, which — unlike a disposable email — persists across repeated runs
// and so can accumulate attempts over a dev session).
export function clearOtpRateLimit(email: string): void {
  const normalized = escapeSql(email.trim().toLowerCase());
  psql(
    `DELETE FROM otp_rate_limit WHERE email IN ` +
      `('send:${normalized}', 'verify:${normalized}', '${normalized}');`,
  );
}

// A fresh, never-seen email per call — OTP login auto-creates an account for unknown
// emails, so tests that shouldn't touch the shared smoke-test account use this instead.
export function disposableEmail(label: string): string {
  const unique = `${process.hrtime.bigint()}-${Math.random().toString(36).slice(2, 8)}`;
  return testAddress(label, unique);
}
