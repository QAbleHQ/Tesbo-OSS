import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { LegacyService } from "./legacy.service";
import { DatabaseService } from "../database/database.service";
import { decryptSecret, encryptSecret } from "../common/crypto.util";
import type { EmailService } from "../auth/email.service";
import type { PasswordService } from "../auth/password.service";
import type { AppConfigService } from "../config/app-config.service";
import type { StorageService } from "../storage/storage.service";
import type { RagIngestionService } from "../rag/rag-ingestion.service";
import type { RagRetrievalService } from "../rag/rag-retrieval.service";
import type { ApiTokenService } from "../auth/api-token.service";

// A key just needs to decode to 32 bytes for aes-256-gcm; this is a throwaway test-only key
// (crypto.util lazily loads it on first encrypt/decrypt call, so setting it at module scope
// before any test runs is sufficient — see src/common/crypto.util.ts).
process.env.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

/**
 * DB double that routes queries to a caller-supplied list of `{ match, rows | handler }` rules,
 * matched by substring against the SQL text (same style as mcp.service.spec.ts / api-token.service.spec.ts).
 * Falls through to an empty result set when nothing matches, and records every call for assertions.
 */
type Route = { match: string; rows?: Record<string, unknown>[]; handler?: (params: unknown[]) => { rows: Record<string, unknown>[] } };

function makeDb(routes: Route[] = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn((sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    for (const route of routes) {
      if (sql.includes(route.match)) {
        return Promise.resolve(route.handler ? route.handler(params) : { rows: route.rows ?? [] });
      }
    }
    return Promise.resolve({ rows: [] });
  });
  return { db: { query } as unknown as DatabaseService, query, calls };
}

/** Route for LegacyService#workspace()'s primary "active organization" lookup. */
function workspaceRoute(role: string, orgId = "org-1"): Route {
  return {
    match: "FROM users u",
    rows: [{ id: orgId, name: "Acme", slug: "acme", role, created_at: "2024-01-01T00:00:00.000Z" }]
  };
}

/** Route for integrationOAuthConfig()'s workspace-saved-config lookup. */
function savedOAuthConfigRoute(row: Record<string, unknown> | null): Route {
  return { match: "FROM integration_oauth_configs", rows: row ? [row] : [] };
}

function makeLegacy(db: DatabaseService): LegacyService {
  return new LegacyService(
    db,
    {} as unknown as EmailService,
    {} as unknown as PasswordService,
    {} as unknown as AppConfigService,
    {} as unknown as StorageService,
    {} as unknown as RagIngestionService,
    {} as unknown as RagRetrievalService,
    {} as unknown as ApiTokenService
  );
}

/** Captures a rejected promise's error without a try/catch block at every call site. */
async function rejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("Expected the promise to reject, but it resolved.");
}

const ENV_KEYS = ["JIRA_CLIENT_ID", "JIRA_CLIENT_SECRET", "JIRA_REDIRECT_URI", "LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET", "LINEAR_REDIRECT_URI"];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  jest.restoreAllMocks();
});

describe("LegacyService — Linear/Jira integration OAuth config resolution", () => {
  it("prefers the workspace-saved config over env vars when both are present", async () => {
    process.env.LINEAR_CLIENT_ID = "env-client";
    process.env.LINEAR_CLIENT_SECRET = "env-secret";
    process.env.LINEAR_REDIRECT_URI = "https://env.example.com/callback";

    const { db } = makeDb([
      workspaceRoute("owner"),
      savedOAuthConfigRoute({ client_id: "db-client", client_secret: encryptSecret("db-secret"), redirect_uri: "https://db.example.com/callback" })
    ]);
    const svc = makeLegacy(db);
    const { url } = await svc.integrationAuthUrl("user-1", "linear");
    const params = new URL(url).searchParams;
    expect(params.get("client_id")).toBe("db-client");
    expect(params.get("redirect_uri")).toBe("https://db.example.com/callback");
  });

  it("falls back to env vars when no workspace config is saved", async () => {
    process.env.LINEAR_CLIENT_ID = "env-client";
    process.env.LINEAR_CLIENT_SECRET = "env-secret";
    process.env.LINEAR_REDIRECT_URI = "https://env.example.com/callback";

    const { db } = makeDb([workspaceRoute("owner"), savedOAuthConfigRoute(null)]);
    const svc = makeLegacy(db);
    const { url } = await svc.integrationAuthUrl("user-1", "linear");
    const params = new URL(url).searchParams;
    expect(params.get("client_id")).toBe("env-client");
    expect(params.get("redirect_uri")).toBe("https://env.example.com/callback");
  });

  it("throws a BadRequestException with an actionable message when neither is configured", async () => {
    const { db } = makeDb([workspaceRoute("owner"), savedOAuthConfigRoute(null)]);
    const svc = makeLegacy(db);
    const err = await rejection(svc.integrationAuthUrl("user-1", "linear"));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toMatch(/linear oauth is not configured/i);
    expect(err.getResponse().error).toMatch(/workspace settings.*integrations/i);
  });

  it("treats a partially-saved workspace row (missing secret) as unconfigured and falls back to env", async () => {
    process.env.LINEAR_CLIENT_ID = "env-client";
    process.env.LINEAR_CLIENT_SECRET = "env-secret";
    process.env.LINEAR_REDIRECT_URI = "https://env.example.com/callback";

    const { db } = makeDb([
      workspaceRoute("owner"),
      savedOAuthConfigRoute({ client_id: "db-client", client_secret: null, redirect_uri: "https://db.example.com/callback" })
    ]);
    const svc = makeLegacy(db);
    const { url } = await svc.integrationAuthUrl("user-1", "linear");
    expect(new URL(url).searchParams.get("client_id")).toBe("env-client");
  });
});

describe("LegacyService#integrationAuthUrl — provider-specific URL construction", () => {
  it("builds the Jira authorize URL with the Jira scope and OAuth params", async () => {
    const { db } = makeDb([
      workspaceRoute("owner"),
      savedOAuthConfigRoute({ client_id: "jira-client", client_secret: encryptSecret("s"), redirect_uri: "https://app.example.com/cb" })
    ]);
    const svc = makeLegacy(db);
    const { url } = await svc.integrationAuthUrl("user-1", "jira");
    expect(url.startsWith("https://auth.atlassian.com/authorize?")).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get("audience")).toBe("api.atlassian.com");
    expect(params.get("client_id")).toBe("jira-client");
    expect(params.get("redirect_uri")).toBe("https://app.example.com/cb");
    expect(params.get("scope")).toBe("read:jira-work read:jira-user write:jira-work offline_access");
    expect(params.get("response_type")).toBe("code");
    expect(params.get("prompt")).toBe("consent");
    expect(params.get("state")).toBe("jira");
  });

  it("builds the Linear authorize URL with the Linear scope and no Jira-only audience param", async () => {
    const { db } = makeDb([
      workspaceRoute("owner"),
      savedOAuthConfigRoute({ client_id: "linear-client", client_secret: encryptSecret("s"), redirect_uri: "https://app.example.com/cb" })
    ]);
    const svc = makeLegacy(db);
    const { url } = await svc.integrationAuthUrl("user-1", "linear");
    expect(url.startsWith("https://linear.app/oauth/authorize?")).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get("scope")).toBe("read,write,issues:create,comments:create");
    expect(params.get("state")).toBe("linear");
    expect(params.has("audience")).toBe(false);
  });

  it("rejects an unsupported provider before ever touching the database", async () => {
    const { db, query } = makeDb();
    const svc = makeLegacy(db);
    const err = await rejection(svc.integrationAuthUrl("user-1", "github"));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("LegacyService#integrationCallback", () => {
  it("forbids a non-owner (manager) from completing the OAuth callback", async () => {
    const { db } = makeDb([workspaceRoute("manager")]);
    const svc = makeLegacy(db);
    const err = await rejection(svc.integrationCallback("user-1", "linear", { code: "abc" }));
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse().error).toMatch(/only the workspace owner/i);
  });

  it("forbids a non-owner (qa_engineer / unrecognized role) from completing the OAuth callback", async () => {
    const { db } = makeDb([workspaceRoute("some-unrecognized-role")]);
    const svc = makeLegacy(db);
    const err = await rejection(svc.integrationCallback("user-1", "linear", { code: "abc" }));
    expect(err).toBeInstanceOf(ForbiddenException);
  });

  it("requires an authorization code", async () => {
    const { db } = makeDb([workspaceRoute("owner")]);
    const svc = makeLegacy(db);
    const err = await rejection(svc.integrationCallback("user-1", "linear", {}));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toMatch(/authorization code is required/i);
  });

  it("rejects an unsupported provider before checking workspace role", async () => {
    const { db, query } = makeDb();
    const svc = makeLegacy(db);
    const err = await rejection(svc.integrationCallback("user-1", "trello", { code: "abc" }));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });

  it("throws when Linear does not return an access token", async () => {
    const { db } = makeDb([workspaceRoute("owner"), savedOAuthConfigRoute({ client_id: "c", client_secret: encryptSecret("s"), redirect_uri: "https://app.example.com/cb" })]);
    const svc = makeLegacy(db);
    jest.spyOn(global, "fetch").mockResolvedValueOnce({ ok: true, json: async () => ({}) } as unknown as Response);

    const err = await rejection(svc.integrationCallback("user-1", "linear", { code: "abc" }));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toMatch(/linear did not return an oauth token/i);
  });

  it("throws when the connected Linear organization cannot be read", async () => {
    const { db } = makeDb([workspaceRoute("owner"), savedOAuthConfigRoute({ client_id: "c", client_secret: encryptSecret("s"), redirect_uri: "https://app.example.com/cb" })]);
    const svc = makeLegacy(db);
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "at-1" }) } as unknown as Response) // token exchange
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { organization: {} } }) } as unknown as Response); // graphql viewer, no urlKey

    const err = await rejection(svc.integrationCallback("user-1", "linear", { code: "abc" }));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toMatch(/could not read the connected linear workspace/i);
  });

  it("upserts the Linear connection with encrypted tokens on a successful callback", async () => {
    const { db, calls } = makeDb([
      workspaceRoute("owner"),
      savedOAuthConfigRoute({ client_id: "c", client_secret: encryptSecret("s"), redirect_uri: "https://app.example.com/cb" }),
      { match: "INSERT INTO integration_connections", handler: () => ({ rows: [{ id: "conn-1", site_url: "https://linear.app/acme" }] }) }
    ]);
    const svc = makeLegacy(db);
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "linear-access-token", refresh_token: "linear-refresh-token", expires_in: 1000 })
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { organization: { id: "org-ext-1", urlKey: "acme" } } }) } as unknown as Response);

    const res = await svc.integrationCallback("user-1", "linear", { code: "abc" });
    expect(res).toEqual({ connectionId: "conn-1", siteUrl: "https://linear.app/acme" });

    const insertCall = calls.find((c) => c.sql.includes("INSERT INTO integration_connections"));
    expect(insertCall).toBeDefined();
    expect(insertCall!.sql).toContain("'linear'");
    expect(insertCall!.sql).toContain("ON CONFLICT (organization_id, provider) DO UPDATE");
    const [organizationId, externalId, siteUrl, accessTokenParam, refreshTokenParam, , connectedBy] = insertCall!.params as string[];
    expect(organizationId).toBe("org-1");
    expect(externalId).toBe("org-ext-1");
    expect(siteUrl).toBe("https://linear.app/acme");
    expect(decryptSecret(accessTokenParam)).toBe("linear-access-token");
    expect(decryptSecret(refreshTokenParam)).toBe("linear-refresh-token");
    expect(connectedBy).toBe("user-1");
  });

  it("throws when Jira omits an access or refresh token", async () => {
    const { db } = makeDb([workspaceRoute("owner"), savedOAuthConfigRoute({ client_id: "c", client_secret: encryptSecret("s"), redirect_uri: "https://app.example.com/cb" })]);
    const svc = makeLegacy(db);
    jest.spyOn(global, "fetch").mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "at-only" }) } as unknown as Response);

    const err = await rejection(svc.integrationCallback("user-1", "jira", { code: "abc" }));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toMatch(/jira did not return oauth tokens/i);
  });

  it("throws when no accessible Jira site is returned", async () => {
    const { db } = makeDb([workspaceRoute("owner"), savedOAuthConfigRoute({ client_id: "c", client_secret: encryptSecret("s"), redirect_uri: "https://app.example.com/cb" })]);
    const svc = makeLegacy(db);
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "at", refresh_token: "rt" }) } as unknown as Response) // token exchange
      .mockResolvedValueOnce({ ok: true, json: async () => [] } as unknown as Response); // accessible-resources: empty

    const err = await rejection(svc.integrationCallback("user-1", "jira", { code: "abc" }));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().error).toMatch(/no accessible jira site/i);
  });

  it("upserts the Jira connection with encrypted tokens on a successful callback", async () => {
    const { db, calls } = makeDb([
      workspaceRoute("owner"),
      savedOAuthConfigRoute({ client_id: "c", client_secret: encryptSecret("s"), redirect_uri: "https://app.example.com/cb" }),
      { match: "INSERT INTO integration_connections", handler: () => ({ rows: [{ id: "conn-jira-1", external_id: "cloud-1", site_url: "https://acme.atlassian.net" }] }) }
    ]);
    const svc = makeLegacy(db);
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "jira-access-token", refresh_token: "jira-refresh-token", expires_in: 3600 })
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => [{ id: "cloud-1", url: "https://acme.atlassian.net" }] } as unknown as Response);

    const res = await svc.integrationCallback("user-1", "jira", { code: "abc" });
    expect(res).toEqual({ connectionId: "conn-jira-1", cloudId: "cloud-1", siteUrl: "https://acme.atlassian.net" });

    const insertCall = calls.find((c) => c.sql.includes("INSERT INTO integration_connections"));
    expect(insertCall!.sql).toContain("'jira'");
    const params = insertCall!.params as string[];
    expect(params[1]).toBe("cloud-1");
    expect(decryptSecret(params[3])).toBe("jira-access-token");
    expect(decryptSecret(params[4])).toBe("jira-refresh-token");
  });
});

describe("LegacyService#linkedLinearKeys — issue-linking aggregate", () => {
  it("aggregates linked Linear issue keys and their testcase counts", async () => {
    const { db, calls } = makeDb([{ match: "FROM testcases WHERE project_id", rows: [{ linear_issue_key: "ENG-1", count: 3 }, { linear_issue_key: "ENG-2", count: 1 }] }]);
    const svc = makeLegacy(db);
    const res = await svc.linkedLinearKeys("proj-1");
    expect(res).toEqual({ keys: ["ENG-1", "ENG-2"], counts: { "ENG-1": 3, "ENG-2": 1 } });
    expect(calls[0].params).toEqual(["proj-1"]);
  });

  it("returns empty keys/counts when no testcase links a Linear issue", async () => {
    const { db } = makeDb([{ match: "FROM testcases WHERE project_id", rows: [] }]);
    const svc = makeLegacy(db);
    expect(await svc.linkedLinearKeys("proj-1")).toEqual({ keys: [], counts: {} });
  });
});

describe("LegacyService#connectLinearTeams — per-project team mapping", () => {
  it("throws NotFoundException when Linear isn't connected for the project's workspace", async () => {
    const { db } = makeDb([{ match: "FROM projects WHERE id", rows: [{ organization_id: "org-1" }] }, { match: "FROM integration_connections WHERE organization_id", rows: [] }]);
    const svc = makeLegacy(db);
    const err = await rejection(svc.connectLinearTeams("proj-1", { projects: [{ id: "team-1", key: "ENG", name: "Engineering" }] }));
    expect(err).toBeInstanceOf(NotFoundException);
  });

  it("replaces existing mappings and links only well-formed teams (drops entries missing id or key)", async () => {
    const { db, calls } = makeDb([
      { match: "FROM projects WHERE id", rows: [{ organization_id: "org-1" }] },
      { match: "FROM integration_connections WHERE organization_id", rows: [{ id: "conn-1", auth_method: "personal_token" }] },
      { match: "DELETE FROM linear_project_mappings", rows: [] },
      { match: "INSERT INTO linear_project_mappings", rows: [] }
    ]);
    const svc = makeLegacy(db);
    const res = await svc.connectLinearTeams("proj-1", {
      projects: [
        { id: "team-1", key: "ENG", name: "Engineering" },
        { id: "", key: "BAD" }, // missing id -> dropped
        { id: "team-2", key: "", name: "No key" } // missing key -> dropped
      ]
    });
    expect(res).toEqual({ linked: 1 });

    const deleteCall = calls.find((c) => c.sql.includes("DELETE FROM linear_project_mappings"));
    expect(deleteCall!.params).toEqual(["proj-1", "conn-1"]);

    const insertCalls = calls.filter((c) => c.sql.includes("INSERT INTO linear_project_mappings"));
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].params).toEqual(["conn-1", "proj-1", "team-1", "ENG", "Engineering"]);
  });

  it("links zero teams (and still clears old mappings) when the request has no valid teams", async () => {
    const { db, calls } = makeDb([
      { match: "FROM projects WHERE id", rows: [{ organization_id: "org-1" }] },
      { match: "FROM integration_connections WHERE organization_id", rows: [{ id: "conn-1", auth_method: "personal_token" }] },
      { match: "DELETE FROM linear_project_mappings", rows: [] }
    ]);
    const svc = makeLegacy(db);
    const res = await svc.connectLinearTeams("proj-1", { projects: [] });
    expect(res).toEqual({ linked: 0 });
    expect(calls.some((c) => c.sql.includes("INSERT INTO linear_project_mappings"))).toBe(false);
  });
});
