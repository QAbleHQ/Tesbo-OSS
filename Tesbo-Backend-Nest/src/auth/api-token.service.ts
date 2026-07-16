import { Injectable, Logger } from "@nestjs/common";
import { createHash, randomBytes } from "crypto";
import { DatabaseService } from "../database/database.service";

/**
 * Result of authenticating a raw API token presented as a bearer credential.
 * Carries the identity/scope needed by the bearer auth path in AuthMiddleware
 * (and, later, by the MCP module) to attribute and authorize machine calls.
 */
export interface ApiTokenPrincipal {
  tokenId: string;
  userId: string | null;
  projectId: string | null;
  scopes: string[];
}

/** Public (never-secret) shape of a token row returned to API clients. */
export interface ApiTokenSummary {
  id: string;
  name: string;
  scopes: string[];
  tokenPrefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

const TOKEN_PREFIX = "tsbo_";
const RAW_TOKEN_BYTES = 24;
const VALID_SCOPES = new Set(["read", "write"]);

/**
 * Issues, lists, revokes and validates project-scoped API tokens.
 *
 * Storage model (migrations/V5_api_tokens_webhooks.sql): only a SHA-256 hash of
 * the token is ever persisted (token_hash, 64 hex chars). The raw token is
 * returned exactly once at creation time and is otherwise unrecoverable.
 *
 * This is the auth foundation the "Tesbo MCP" card builds on: the MCP module
 * (next slice) will consume ApiTokenPrincipal to authenticate machine clients
 * and attribute their writes to a dedicated actor.
 */
@Injectable()
export class ApiTokenService {
  private readonly logger = new Logger(ApiTokenService.name);

  constructor(private readonly db: DatabaseService) {}

  /** Deterministic one-way hash used for both storage and lookup. */
  hashToken(rawToken: string): string {
    return createHash("sha256").update(rawToken, "utf8").digest("hex");
  }

  /** Generates a fresh, prefixed, high-entropy raw token. */
  generateRawToken(): string {
    return TOKEN_PREFIX + randomBytes(RAW_TOKEN_BYTES).toString("hex");
  }

  private normalizeScopes(input: unknown): string[] {
    const requested = Array.isArray(input)
      ? input.map((s) => String(s).trim().toLowerCase())
      : String(input ?? "")
          .split(",")
          .map((s) => s.trim().toLowerCase());
    const filtered = requested.filter((s) => VALID_SCOPES.has(s));
    // Default to read+write when nothing valid was supplied.
    return filtered.length ? Array.from(new Set(filtered)) : ["read", "write"];
  }

  private toSummary(row: {
    id: string;
    name: string;
    scopes: string | null;
    token_hash: string;
    last_used_at: string | null;
    created_at: string;
  }): ApiTokenSummary {
    return {
      id: row.id,
      name: row.name,
      scopes: (row.scopes || "").split(",").map((s) => s.trim()).filter(Boolean),
      // A stable, non-reversible hint so UIs can distinguish tokens without the secret.
      tokenPrefix: `${TOKEN_PREFIX}…${row.token_hash.slice(-6)}`,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at
    };
  }

  async listTokens(projectId: string): Promise<ApiTokenSummary[]> {
    const res = await this.db.query(
      `SELECT id, name, scopes, token_hash, last_used_at, created_at
       FROM api_tokens WHERE project_id = $1 ORDER BY created_at DESC`,
      [projectId]
    );
    return res.rows.map((row) => this.toSummary(row as never));
  }

  /**
   * Creates a token for a project. Returns the summary plus the raw `token`,
   * which is shown to the caller exactly once and never stored in plaintext.
   */
  async issueToken(
    userId: string | null,
    projectId: string,
    name: string,
    scopesInput?: unknown
  ): Promise<ApiTokenSummary & { token: string }> {
    const rawToken = this.generateRawToken();
    const tokenHash = this.hashToken(rawToken);
    const scopes = this.normalizeScopes(scopesInput).join(",");
    const res = await this.db.query(
      `INSERT INTO api_tokens (user_id, project_id, name, token_hash, scopes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, scopes, token_hash, last_used_at, created_at`,
      [userId, projectId, name, tokenHash, scopes]
    );
    return { ...this.toSummary(res.rows[0] as never), token: rawToken };
  }

  /** Deletes a token belonging to the given project. Returns whether a row was removed. */
  async revokeToken(projectId: string, tokenId: string): Promise<boolean> {
    const res = await this.db.query(
      `DELETE FROM api_tokens WHERE id = $1 AND project_id = $2`,
      [tokenId, projectId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Validates a raw bearer token. On success returns the principal and
   * records last_used_at; returns null for any unknown/blank token.
   */
  async authenticate(rawToken: string | null | undefined): Promise<ApiTokenPrincipal | null> {
    const token = String(rawToken ?? "").trim();
    if (!token) return null;
    const tokenHash = this.hashToken(token);
    const res = await this.db.query(
      `SELECT id, user_id, project_id, scopes FROM api_tokens WHERE token_hash = $1 LIMIT 1`,
      [tokenHash]
    );
    const row = res.rows[0] as
      | { id: string; user_id: string | null; project_id: string | null; scopes: string | null }
      | undefined;
    if (!row) return null;
    // Best-effort usage stamp; never block auth on the update.
    this.db
      .query(`UPDATE api_tokens SET last_used_at = now() WHERE id = $1`, [row.id])
      .catch((err) => this.logger.warn(`Failed to update last_used_at for token ${row.id}: ${err}`));
    return {
      tokenId: row.id,
      userId: row.user_id,
      projectId: row.project_id,
      scopes: (row.scopes || "").split(",").map((s) => s.trim()).filter(Boolean)
    };
  }
}
