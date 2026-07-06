import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Response } from "express";
import { AuditService } from "../audit/audit.service";
import { AuthService } from "../auth/auth.service";
import { OtpService } from "../auth/otp.service";
import { PasswordService } from "../auth/password.service";
import { AppConfigService } from "../config/app-config.service";
import { AuthenticatedRequest } from "../common/request.types";
import { DatabaseService } from "../database/database.service";
import { InvitationRow, LegacyService } from "./legacy.service";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface PendingSignupRow {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  invitation_id: string | null;
}

@Injectable()
export class SignupService {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfigService,
    private readonly otp: OtpService,
    private readonly password: PasswordService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly legacy: LegacyService
  ) {}

  async startSelfServeSignup(name: string | undefined, rawEmail: string | undefined, password: string | undefined, ip: string, ua?: string | null): Promise<void> {
    const email = this.validateEmail(rawEmail);
    const trimmedName = this.validateName(name);
    this.validatePassword(password);

    const existing = await this.db.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rows[0]) throw new BadRequestException({ error: "An account with this email already exists. Please sign in instead." });

    const passwordHash = this.password.hashPassword(password!.trim());
    await this.insertPendingSignup(email, trimmedName, passwordHash, null);

    await this.sendOtp(email, ip, ua);
    await this.audit.log(null, "signup_started", "auth", email, "{}", ip, ua);
  }

  async verifySelfServeSignup(rawEmail: string | undefined, code: string | undefined, ip: string, ua: string | null | undefined, req: AuthenticatedRequest, res: Response) {
    const email = this.validateEmail(rawEmail);
    if (!code?.trim()) throw new BadRequestException({ error: "code is required" });
    if (!(await this.otp.verifyOtpCode(email, code, ip))) throw new UnauthorizedException({ error: "invalid_or_expired_otp" });

    const pending = await this.findPendingSignup(email, null);
    if (!pending) throw new BadRequestException({ error: "No pending signup found for this email. Please start again." });

    const userId = await this.createUserFromPending(pending);
    await this.auth.signInUser(userId, email, req, res);
    await this.audit.log(userId, "signup_completed", "auth", email, "{}", ip, ua);
    return { ok: true, userId };
  }

  async startInviteRegistration(token: string, name: string | undefined, password: string | undefined, ip: string, ua?: string | null): Promise<void> {
    const inv = await this.legacy.getInvitationRowOrThrow(token);
    const trimmedName = this.validateName(name);
    this.validatePassword(password);
    await this.assertEmailNotTaken(inv.email);

    const passwordHash = this.password.hashPassword(password!.trim());
    await this.insertPendingSignup(inv.email, trimmedName, passwordHash, inv.id);

    await this.sendOtp(inv.email, ip, ua);
  }

  async startInviteOtpRegistration(token: string, name: string | undefined, ip: string, ua?: string | null): Promise<void> {
    const inv = await this.legacy.getInvitationRowOrThrow(token);
    const trimmedName = this.validateName(name);
    await this.assertEmailNotTaken(inv.email);

    await this.insertPendingSignup(inv.email, trimmedName, null, inv.id);

    await this.sendOtp(inv.email, ip, ua);
  }

  async verifyInviteRegistration(token: string, code: string | undefined, ip: string, ua: string | null | undefined, req: AuthenticatedRequest, res: Response) {
    return this.completeInviteVerification(token, code, ip, ua, req, res);
  }

  async verifyInviteOtpRegistration(token: string, code: string | undefined, ip: string, ua: string | null | undefined, req: AuthenticatedRequest, res: Response) {
    return this.completeInviteVerification(token, code, ip, ua, req, res);
  }

  private async completeInviteVerification(token: string, code: string | undefined, ip: string, ua: string | null | undefined, req: AuthenticatedRequest, res: Response) {
    const inv = await this.legacy.getInvitationRowOrThrow(token);
    if (!code?.trim()) throw new BadRequestException({ error: "code is required" });
    if (!(await this.otp.verifyOtpCode(inv.email, code, ip))) throw new UnauthorizedException({ error: "invalid_or_expired_otp" });

    const pending = await this.findPendingSignup(inv.email, inv.id);
    if (!pending) throw new BadRequestException({ error: "No pending registration found for this invite. Please start again." });

    const userId = await this.completeInviteRegistration(inv, pending);
    await this.auth.signInUser(userId, inv.email, req, res);
    await this.audit.log(userId, "invite_registration_completed", "organization", inv.organization_id, "{}", ip, ua);
    return { ok: true, userId, organizationId: inv.organization_id };
  }

  private async completeInviteRegistration(inv: InvitationRow, pending: PendingSignupRow): Promise<string> {
    return this.db.transaction(async (client) => {
      const userId = await this.insertUser(client, pending.email, pending.name, pending.password_hash);
      await client.query(
        "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3)",
        [inv.organization_id, userId, inv.role]
      );
      await client.query("UPDATE users SET active_organization_id = $1, updated_at = now() WHERE id = $2", [
        inv.organization_id,
        userId
      ]);
      if (inv.project_ids?.length > 0) {
        for (const projectId of inv.project_ids) {
          await client.query(
            "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
            [projectId, userId, inv.role]
          );
        }
      }
      await client.query(
        "UPDATE invitations SET status = 'accepted', accepted_at = now(), updated_at = now() WHERE id = $1",
        [inv.id]
      );
      await client.query("UPDATE pending_signups SET consumed_at = now() WHERE id = $1", [pending.id]);
      return userId;
    });
  }

  private async createUserFromPending(pending: PendingSignupRow): Promise<string> {
    return this.db.transaction(async (client) => {
      const userId = await this.insertUser(client, pending.email, pending.name, pending.password_hash);
      await client.query("UPDATE pending_signups SET consumed_at = now() WHERE id = $1", [pending.id]);
      return userId;
    });
  }

  private async insertUser(client: PoolClient, email: string, name: string, passwordHash: string | null): Promise<string> {
    try {
      const result = await client.query<{ id: string }>(
        "INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id",
        [email, name, passwordHash]
      );
      return result.rows[0].id;
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException({ error: "An account with this email already exists. Please sign in instead." });
      }
      throw error;
    }
  }

  private async insertPendingSignup(email: string, name: string, passwordHash: string | null, invitationId: string | null): Promise<void> {
    const expiresAt = new Date(Date.now() + this.config.otpExpiryMinutes * 60_000);
    await this.db.query(
      "INSERT INTO pending_signups (email, name, password_hash, invitation_id, expires_at) VALUES ($1, $2, $3, $4, $5)",
      [email, name, passwordHash, invitationId, expiresAt]
    );
  }

  private async findPendingSignup(email: string, invitationId: string | null): Promise<PendingSignupRow | null> {
    const result = await this.db.query<PendingSignupRow>(
      `SELECT id, email, name, password_hash, invitation_id FROM pending_signups
       WHERE email = $1 AND invitation_id IS NOT DISTINCT FROM $2 AND consumed_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [email, invitationId]
    );
    return result.rows[0] ?? null;
  }

  private async sendOtp(email: string, ip: string, ua?: string | null): Promise<void> {
    let sent = false;
    try {
      sent = await this.otp.requestOtp(email, ip, ua);
    } catch {
      throw new ServiceUnavailableException({ error: "otp_delivery_failed" });
    }
    if (!sent) throw new BadRequestException({ error: "rate_limited_or_invalid" });
  }

  private async assertEmailNotTaken(email: string): Promise<void> {
    const existing = await this.db.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rows[0]) throw new BadRequestException({ error: "An account with this email already exists. Please sign in and accept the invite." });
  }

  private validateEmail(rawEmail: string | undefined): string {
    const email = (rawEmail ?? "").trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) throw new BadRequestException({ error: "invalid email address" });
    return email;
  }

  private validateName(name: string | undefined): string {
    const trimmed = (name ?? "").trim();
    if (!trimmed) throw new BadRequestException({ error: "name is required" });
    return trimmed;
  }

  private validatePassword(password: string | undefined): void {
    if (!password || password.trim().length < 8) throw new BadRequestException({ error: "password must be at least 8 characters" });
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505";
  }
}
