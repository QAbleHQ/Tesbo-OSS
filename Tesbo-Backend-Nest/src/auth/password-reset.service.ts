import { Injectable } from "@nestjs/common";
import { randomBytes, createHash } from "crypto";
import { AppConfigService } from "../config/app-config.service";
import { DatabaseService } from "../database/database.service";
import { EmailService } from "./email.service";
import { PasswordService } from "./password.service";

@Injectable()
export class PasswordResetService {
  private readonly tokenExpiryMinutes = 60;

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfigService,
    private readonly email: EmailService,
    private readonly password: PasswordService
  ) {}

  /**
   * Reports whether the email is registered — the UI shows a distinct "no account with that
   * email" message rather than a generic "check your email", so callers can surface it.
   */
  async requestReset(rawEmail: string, ipAddress?: string | null): Promise<"sent" | "rate_limited" | "not_found"> {
    const email = rawEmail.trim().toLowerCase();
    if (!email) return "not_found";
    const ipKey = `ip:${ipAddress?.trim() ?? ""}`;
    if ((await this.isRateLimited(this.sendLimitKey(email))) || (await this.isRateLimited(this.sendLimitKey(ipKey)))) {
      return "rate_limited";
    }
    await this.recordAttempt(this.sendLimitKey(email));
    await this.recordAttempt(this.sendLimitKey(ipKey));

    const result = await this.db.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]);
    const userId = result.rows[0]?.id;
    if (!userId) return "not_found";

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + this.tokenExpiryMinutes * 60_000);
    await this.db.query("INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)", [
      userId,
      this.hash(token),
      expiresAt
    ]);
    await this.email.sendPasswordReset(email, `${this.config.frontendUrl}/reset-password/${token}`);
    return "sent";
  }

  async verifyResetToken(rawToken: string): Promise<boolean> {
    return (await this.findValidToken(rawToken)) !== null;
  }

  async resetPassword(rawToken: string, newPassword: string): Promise<string | null> {
    const row = await this.findValidToken(rawToken);
    if (!row) return null;

    await this.password.setPassword(row.user_id, newPassword);
    await this.db.query("UPDATE password_reset_tokens SET used_at = now() WHERE id = $1", [row.id]);
    // A password reset invalidates every existing session, browser or otherwise — otherwise
    // whoever (or whatever) stole the old password would keep their session alive right through it.
    await this.db.query("DELETE FROM sessions WHERE user_id = $1", [row.user_id]);
    return row.user_id;
  }

  private async findValidToken(rawToken: string): Promise<{ id: string; user_id: string } | null> {
    const token = rawToken?.trim();
    if (!token) return null;
    const result = await this.db.query<{ id: string; user_id: string }>(
      "SELECT id, user_id FROM password_reset_tokens WHERE token_hash = $1 AND expires_at > now() AND used_at IS NULL",
      [this.hash(token)]
    );
    return result.rows[0] ?? null;
  }

  private async isRateLimited(key: string): Promise<boolean> {
    const result = await this.db.query<{ locked_until: Date | null }>("SELECT locked_until FROM otp_rate_limit WHERE email = $1", [key]);
    const lockedUntil = result.rows[0]?.locked_until;
    return !!lockedUntil && lockedUntil.getTime() > Date.now();
  }

  private async recordAttempt(key: string): Promise<void> {
    const sql = `
      INSERT INTO otp_rate_limit (email, attempt_count, locked_until, updated_at)
      VALUES ($1, 1, NULL, now())
      ON CONFLICT (email) DO UPDATE
      SET attempt_count = otp_rate_limit.attempt_count + 1,
          locked_until = CASE
            WHEN otp_rate_limit.attempt_count + 1 >= $2 THEN now() + ($3 || ' minutes')::interval
            ELSE otp_rate_limit.locked_until
          END,
          updated_at = now()
    `;
    await this.db.query(sql, [key, this.config.otpMaxAttempts, this.config.otpRateLimitWindowMinutes]);
  }

  private sendLimitKey(key: string): string {
    return `reset:send:${key}`;
  }

  private hash(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("base64url");
  }
}
