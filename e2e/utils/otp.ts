import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { env } from "./env";

// Mirrors Tesbo-Backend-Nest/src/auth/otp.service.ts's OtpService.hash exactly
// (sha256, base64url) — if that ever changes, this needs to change with it.
function hashOtpCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("base64url");
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

function psql(sql: string): void {
  execSync(
    `docker compose -f "${env.dockerComposeFile}" exec -T ${env.dbService} psql -U ${env.dbUser} -d ${env.dbName} -v ON_ERROR_STOP=1`,
    { input: sql, encoding: "utf-8" },
  );
}

// Bypasses real OTP delivery by inserting a known code straight into Postgres — the same
// technique global-setup.ts uses to seed a known password hash. Needed here because this
// stack has a real POSTMARK_API_TOKEN configured, so OTP codes go out as actual email
// instead of landing in the backend container's stdout. `expiresInMinutes` can be negative
// to seed an already-expired code.
export function seedOtpCode(email: string, code: string, expiresInMinutes = 10): void {
  const normalizedEmail = escapeSql(email.trim().toLowerCase());
  const codeHash = hashOtpCode(code);
  psql(
    `INSERT INTO otp_codes (email, code_hash, expires_at) VALUES ` +
      `('${normalizedEmail}', '${codeHash}', now() + interval '${expiresInMinutes} minutes');`,
  );
}

// otp_rate_limit holds one row per email plus one `ip:<address>` row per caller IP. Every
// OTP-touching test in this run looks like the same caller IP to the backend, so that row
// is genuinely shared and safe to reset — but a blanket `DELETE FROM otp_rate_limit` would
// also wipe a concurrently-running test's own per-email counter (e.g. the dedicated
// rate-limit test's disposable email mid-loop), racily resetting its progress. Only ever
// clear the ip: rows here; use clearOtpRateLimit(email) for a specific email.
export function clearOtpIpRateLimit(): void {
  psql("DELETE FROM otp_rate_limit WHERE email LIKE 'ip:%';");
}

// Clears the rate-limit counter for one specific, known email (e.g. the shared
// smoke-test account, which — unlike a disposable email — persists across repeated runs
// and so can accumulate attempts over a dev session).
export function clearOtpRateLimit(email: string): void {
  psql(`DELETE FROM otp_rate_limit WHERE email = '${escapeSql(email.trim().toLowerCase())}';`);
}

// A fresh, never-seen email per call — OTP login auto-creates an account for unknown
// emails, so tests that shouldn't touch the shared smoke-test account use this instead.
export function disposableEmail(label: string): string {
  const unique = `${process.hrtime.bigint()}-${Math.random().toString(36).slice(2, 8)}`;
  return `e2e-${label}-${unique}@tesbo.local`;
}
