import { createHash } from "crypto";
import { ApiTokenService } from "./api-token.service";
import { DatabaseService } from "../database/database.service";

function makeDb(rows: Record<string, unknown>[] = [], rowCount?: number) {
  const query = jest.fn().mockResolvedValue({ rows, rowCount: rowCount ?? rows.length });
  return { db: { query } as unknown as DatabaseService, query };
}

describe("ApiTokenService", () => {
  describe("hashToken", () => {
    it("produces a stable 64-char sha256 hex digest", () => {
      const { db } = makeDb();
      const svc = new ApiTokenService(db);
      const hash = svc.hashToken("tsbo_abc");
      expect(hash).toHaveLength(64);
      expect(hash).toBe(createHash("sha256").update("tsbo_abc", "utf8").digest("hex"));
      expect(svc.hashToken("tsbo_abc")).toBe(hash); // deterministic
    });
  });

  describe("generateRawToken", () => {
    it("returns prefixed, high-entropy, unique tokens", () => {
      const { db } = makeDb();
      const svc = new ApiTokenService(db);
      const a = svc.generateRawToken();
      const b = svc.generateRawToken();
      expect(a).toMatch(/^tsbo_[0-9a-f]{48}$/);
      expect(a).not.toBe(b);
    });
  });

  describe("issueToken", () => {
    it("stores only the hash and returns the raw token exactly once", async () => {
      const created = new Date().toISOString();
      const { db, query } = makeDb([
        { id: "tok-1", name: "CI", scopes: "read,write", token_hash: "f".repeat(64), last_used_at: null, created_at: created }
      ]);
      const svc = new ApiTokenService(db);
      const result = await svc.issueToken("user-1", "proj-1", "CI", "read,write");

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain("INSERT INTO api_tokens");
      // Params: [userId, projectId, name, tokenHash, scopes]
      expect(params[0]).toBe("user-1");
      expect(params[1]).toBe("proj-1");
      expect(params[3]).toBe(svc.hashToken(result.token)); // hash matches raw
      expect(params[3]).not.toBe(result.token); // raw never stored
      expect(result.token).toMatch(/^tsbo_/);
      expect(result.scopes).toEqual(["read", "write"]);
    });

    it("defaults to read+write when no valid scopes supplied", async () => {
      const { db, query } = makeDb([
        { id: "t", name: "n", scopes: "read,write", token_hash: "a".repeat(64), last_used_at: null, created_at: "now" }
      ]);
      const svc = new ApiTokenService(db);
      await svc.issueToken("u", "p", "n", "bogus,delete");
      expect(query.mock.calls[0][1][4]).toBe("read,write");
    });
  });

  describe("revokeToken", () => {
    it("reports true when a row is deleted and false otherwise", async () => {
      const del = makeDb([], 1);
      expect(await new ApiTokenService(del.db).revokeToken("p", "t")).toBe(true);
      const none = makeDb([], 0);
      expect(await new ApiTokenService(none.db).revokeToken("p", "t")).toBe(false);
    });
  });

  describe("authenticate", () => {
    it("returns null for blank tokens without hitting the db", async () => {
      const { db, query } = makeDb();
      const svc = new ApiTokenService(db);
      expect(await svc.authenticate("")).toBeNull();
      expect(await svc.authenticate(null)).toBeNull();
      expect(query).not.toHaveBeenCalled();
    });

    it("returns null when no matching token row exists", async () => {
      const { db } = makeDb([]);
      expect(await new ApiTokenService(db).authenticate("tsbo_missing")).toBeNull();
    });

    it("maps a matching row to a principal and stamps last_used_at", async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce({
          rows: [{ id: "tok-9", user_id: "user-9", project_id: "proj-9", scopes: "read,write" }],
          rowCount: 1
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });
      const svc = new ApiTokenService({ query } as unknown as DatabaseService);

      const principal = await svc.authenticate("tsbo_secret");
      expect(principal).toEqual({
        tokenId: "tok-9",
        userId: "user-9",
        projectId: "proj-9",
        scopes: ["read", "write"]
      });
      // Looks up by the hash of the presented token.
      expect(query.mock.calls[0][1][0]).toBe(svc.hashToken("tsbo_secret"));
      // Second call updates usage.
      expect(query.mock.calls[1][0]).toContain("UPDATE api_tokens SET last_used_at");
    });
  });
});
