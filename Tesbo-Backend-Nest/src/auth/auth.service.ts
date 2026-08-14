import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException
} from "@nestjs/common";
import type { Response } from "express";
import { AuditService } from "../audit/audit.service";
import { AuthenticatedRequest } from "../common/request.types";
import { AppConfigService } from "../config/app-config.service";
import { DatabaseService } from "../database/database.service";
import { SuperAdminService } from "../admin/super-admin.service";
import { EmailService } from "./email.service";
import { OtpService } from "./otp.service";
import { PasswordResetService } from "./password-reset.service";
import { PasswordService } from "./password.service";

@Injectable()
export class AuthService {
  constructor(
    private readonly config: AppConfigService,
    private readonly db: DatabaseService,
    private readonly otp: OtpService,
    private readonly password: PasswordService,
    private readonly passwordReset: PasswordResetService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
    private readonly superAdmin: SuperAdminService
  ) {}

  async requestOtp(email: string | undefined, req: AuthenticatedRequest): Promise<void> {
    if (!email) throw new BadRequestException({ error: "email required" });
    let sent = false;
    try {
      sent = await this.otp.requestOtp(email, this.ip(req), req.get("user-agent"));
    } catch {
      throw new ServiceUnavailableException({ error: "otp_delivery_failed" });
    }
    if (!sent) throw new HttpException({ error: "rate_limited_or_invalid" }, HttpStatus.TOO_MANY_REQUESTS);
    await this.audit.log(null, "otp_requested", "auth", email, "{}", this.ip(req), req.get("user-agent"));
  }

  async verifyOtp(email: string | undefined, code: string | undefined, req: AuthenticatedRequest, res: Response) {
    if (!email || !code) throw new BadRequestException({ error: "email and code required" });
    const token = await this.otp.verifyOtp(email.trim(), code, this.ip(req), req.get("user-agent"));
    if (!token) throw new UnauthorizedException({ error: "invalid_or_expired_otp" });
    const userId = await this.otp.resolveSession(token);
    if (!userId) throw new UnauthorizedException({ error: "invalid_or_expired_otp" });
    await this.audit.log(userId, "login", "auth", email, "{}", this.ip(req), req.get("user-agent"));
    this.setSessionCookie(req, res, token, 86400 * this.config.sessionDays);
    return { ok: true, userId };
  }

  async loginWithPassword(email: string | undefined, password: string | undefined, req: AuthenticatedRequest, res: Response) {
    if (!email || !password) throw new BadRequestException({ error: "email and password required" });
    const normalizedEmail = email.trim().toLowerCase();
    const emailKey = this.loginLimitKey(normalizedEmail);
    const ipKey = this.loginLimitKey(`ip:${this.ip(req)}`);

    if ((await this.isLoginRateLimited(emailKey)) || (await this.isLoginRateLimited(ipKey))) {
      throw new HttpException({ error: "account_temporarily_locked" }, HttpStatus.TOO_MANY_REQUESTS);
    }

    const userId = await this.password.verifyLogin(email, password);
    if (!userId) {
      await this.recordLoginAttempt(emailKey);
      await this.recordLoginAttempt(ipKey);
      throw new UnauthorizedException({ error: "invalid_email_or_password" });
    }
    // A successful login only clears this account's own counter — a shared IP (e.g. an
    // office NAT) with a lockout in progress for a *different* account must stay locked.
    await this.clearLoginRateLimit(emailKey);

    const token = await this.otp.createSession(userId, this.ip(req), req.get("user-agent"));
    await this.audit.log(userId, "login", "auth", normalizedEmail, "{}", this.ip(req), req.get("user-agent"));
    this.setSessionCookie(req, res, token, 86400 * this.config.sessionDays);
    return { ok: true, userId };
  }

  async forgotPassword(email: string | undefined, req: AuthenticatedRequest): Promise<void> {
    if (!email) throw new BadRequestException({ error: "email required" });
    const outcome = await this.passwordReset.requestReset(email, this.ip(req));
    if (outcome === "rate_limited") throw new HttpException({ error: "rate_limited" }, HttpStatus.TOO_MANY_REQUESTS);
    if (outcome === "not_found") throw new NotFoundException({ error: "No account found with that email address" });
    await this.audit.log(null, "password_reset_requested", "auth", email.trim().toLowerCase(), "{}", this.ip(req), req.get("user-agent"));
  }

  async checkResetToken(token: string | undefined): Promise<{ valid: boolean }> {
    if (!token) return { valid: false };
    return { valid: await this.passwordReset.verifyResetToken(token) };
  }

  async resetPassword(token: string | undefined, password: string | undefined, req: AuthenticatedRequest): Promise<{ ok: true }> {
    if (!token || !password) throw new BadRequestException({ error: "token and password required" });
    this.password.assertValidPassword(password);
    const userId = await this.passwordReset.resetPassword(token, password);
    if (!userId) throw new UnauthorizedException({ error: "invalid_or_expired_token" });
    await this.audit.log(userId, "password_reset", "auth", null, "{}", this.ip(req), req.get("user-agent"));
    return { ok: true };
  }

  async changePassword(
    userId: string,
    currentPassword: string | undefined,
    newPassword: string | undefined,
    req: AuthenticatedRequest
  ): Promise<void> {
    if (!newPassword) throw new BadRequestException({ error: "new password required" });
    this.password.assertValidPassword(newPassword);

    // A user who signed up via OTP and never set a password has nothing to verify against —
    // this doubles as "set a password for the first time" for them. Anyone with a password
    // already must prove they know it before it can be changed.
    if (await this.password.hasPassword(userId)) {
      if (!currentPassword) throw new BadRequestException({ error: "current password required" });
      const valid = await this.password.verifyCurrentPassword(userId, currentPassword);
      if (!valid) throw new UnauthorizedException({ error: "invalid_current_password" });
    }

    await this.password.setPassword(userId, newPassword);

    const currentToken = req.cookies?.[this.config.sessionCookieName];
    if (currentToken) await this.otp.invalidateOtherSessions(userId, currentToken);

    const userRow = await this.db.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [userId]);
    const email = userRow.rows[0]?.email;
    if (email) await this.email.sendPasswordChanged(email);

    await this.audit.log(userId, "password_changed", "auth", null, "{}", this.ip(req), req.get("user-agent"));
  }

  async signInUser(userId: string, email: string, req: AuthenticatedRequest, res: Response): Promise<void> {
    const token = await this.otp.createSession(userId, this.ip(req), req.get("user-agent"));
    await this.audit.log(userId, "login", "auth", email, "{}", this.ip(req), req.get("user-agent"));
    this.setSessionCookie(req, res, token, 86400 * this.config.sessionDays);
  }

  async logout(req: AuthenticatedRequest, res: Response): Promise<void> {
    const token = req.cookies?.[this.config.sessionCookieName];
    if (token) {
      await this.otp.invalidateSession(token);
      this.clearSessionCookie(req, res);
    }
    if (req.userId) {
      await this.audit.log(req.userId, "logout", "auth", null, "{}", this.ip(req), req.get("user-agent"));
    }
  }

  async me(userId: string) {
    const [isPlatformAdmin, userRow, hasPassword] = await Promise.all([
      this.superAdmin.isPlatformAdmin(userId),
      this.db.query<{ email: string; name: string | null }>("SELECT email, name FROM users WHERE id = $1", [userId]),
      this.password.hasPassword(userId)
    ]);
    return {
      userId,
      isPlatformAdmin,
      email: userRow.rows[0]?.email ?? null,
      name: userRow.rows[0]?.name ?? null,
      hasPassword
    };
  }

  private setSessionCookie(req: AuthenticatedRequest, res: Response, token: string, maxAgeSeconds: number) {
    res.cookie(this.config.sessionCookieName, token, {
      path: "/",
      maxAge: maxAgeSeconds * 1000,
      httpOnly: true,
      sameSite: "lax",
      secure: this.isSecureRequest(req)
    });
  }

  private clearSessionCookie(req: AuthenticatedRequest, res: Response) {
    res.cookie(this.config.sessionCookieName, "", {
      path: "/",
      maxAge: 0,
      httpOnly: true,
      sameSite: "lax",
      secure: this.isSecureRequest(req)
    });
  }

  private isSecureRequest(req: AuthenticatedRequest): boolean {
    const forwardedProto = req.get("x-forwarded-proto");
    return req.secure || forwardedProto?.trim().toLowerCase() === "https" || this.config.frontendUrl.startsWith("https://");
  }

  private ip(req: AuthenticatedRequest): string {
    return req.ip ?? "";
  }

  private loginLimitKey(key: string): string {
    return `login:${key}`;
  }

  private async isLoginRateLimited(key: string): Promise<boolean> {
    const result = await this.db.query<{ locked_until: Date | null }>("SELECT locked_until FROM otp_rate_limit WHERE email = $1", [key]);
    const lockedUntil = result.rows[0]?.locked_until;
    return !!lockedUntil && lockedUntil.getTime() > Date.now();
  }

  private async recordLoginAttempt(key: string): Promise<void> {
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
    await this.db.query(sql, [key, this.config.passwordLoginMaxAttempts, this.config.passwordLoginLockoutMinutes]);
  }

  private async clearLoginRateLimit(key: string): Promise<void> {
    await this.db.query("DELETE FROM otp_rate_limit WHERE email = $1", [key]);
  }
}
