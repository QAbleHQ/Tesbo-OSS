import { BadRequestException, Injectable } from "@nestjs/common";
import { pbkdf2Sync, randomBytes, timingSafeEqual } from "crypto";
import { DatabaseService } from "../database/database.service";

const MIN_LENGTH = 8;
const MAX_LENGTH = 128;

@Injectable()
export class PasswordService {
  private readonly iterations = 210000;
  private readonly keyLengthBytes = 32;

  constructor(private readonly db: DatabaseService) {}

  /**
   * The single source of truth for password policy — every path that sets a password
   * (signup, invite registration, first-admin setup, change-password, reset-password)
   * goes through hashPassword(), so this is the one place the rule can ever diverge.
   */
  assertValidPassword(password: string | undefined): void {
    const value = password ?? "";
    if (value.length < MIN_LENGTH) {
      throw new BadRequestException({ error: `Password must be at least ${MIN_LENGTH} characters` });
    }
    if (value.length > MAX_LENGTH) {
      throw new BadRequestException({ error: `Password must be at most ${MAX_LENGTH} characters` });
    }
    if (!/[a-z]/.test(value)) {
      throw new BadRequestException({ error: "Password must include at least one lowercase letter" });
    }
    if (!/[A-Z]/.test(value)) {
      throw new BadRequestException({ error: "Password must include at least one uppercase letter" });
    }
    if (!/[0-9]/.test(value)) {
      throw new BadRequestException({ error: "Password must include at least one number" });
    }
  }

  async verifyLogin(
    rawEmail: string,
    password: string
  ): Promise<{ outcome: "ok"; userId: string } | { outcome: "not_found" } | { outcome: "invalid_password" }> {
    if (!rawEmail?.trim() || !password?.trim()) return { outcome: "invalid_password" };
    const email = rawEmail.trim().toLowerCase();
    const result = await this.db.query<{ id: string; password_hash: string | null }>(
      "SELECT id, password_hash FROM users WHERE email = $1",
      [email]
    );
    const row = result.rows[0];
    if (!row) return { outcome: "not_found" };
    if (!row.password_hash) return { outcome: "invalid_password" };
    return this.verifyPassword(password, row.password_hash)
      ? { outcome: "ok", userId: row.id }
      : { outcome: "invalid_password" };
  }

  hashPassword(password: string): string {
    this.assertValidPassword(password);
    const salt = randomBytes(16);
    const hash = pbkdf2Sync(password, salt, this.iterations, this.keyLengthBytes, "sha256");
    return `pbkdf2_sha256$${this.iterations}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
  }

  async hasPassword(userId: string): Promise<boolean> {
    const result = await this.db.query<{ password_hash: string | null }>("SELECT password_hash FROM users WHERE id = $1", [userId]);
    return !!result.rows[0]?.password_hash;
  }

  async verifyCurrentPassword(userId: string, currentPassword: string): Promise<boolean> {
    const result = await this.db.query<{ password_hash: string | null }>("SELECT password_hash FROM users WHERE id = $1", [userId]);
    const hash = result.rows[0]?.password_hash;
    if (!hash) return false;
    return this.verifyPassword(currentPassword, hash);
  }

  async setPassword(userId: string, newPassword: string): Promise<void> {
    const passwordHash = this.hashPassword(newPassword);
    await this.db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, userId]);
  }

  private verifyPassword(password: string, storedHash: string): boolean {
    try {
      const parts = storedHash.split("$");
      if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") return false;
      const iterations = Number.parseInt(parts[1], 10);
      const salt = Buffer.from(parts[2], "base64url");
      const expected = Buffer.from(parts[3], "base64url");
      const actual = pbkdf2Sync(password, salt, iterations, expected.length, "sha256");
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }
}
