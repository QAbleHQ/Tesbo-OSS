import { expect, test, type APIRequestContext } from "@playwright/test";
import { testAddress } from "../utils/env";
import { dbControlAvailable, exec, execAllowingAuditImmutability, literal, scalar } from "../utils/psql";
import { anonymousContext, detachUserByEmail, loginAs, seedFixtureUser } from "../utils/rbac-tenant";

/*
 * POST /api/onboarding/workspace — the step a brand-new signup lands on, where they name their
 * workspace before they can reach anything else.
 *
 * Reported from production as a 500 (BetterBugs 6a7afa2d, "500 Internal Server Error while creating
 * workspace"): signup completed, the user reached /onboarding, typed a name, pressed Continue, and
 * the POST failed. The session log shows it retried four times and failed every time — so this is
 * the one screen a new account cannot get past, which makes it the highest-consequence 500 in the
 * product: the account exists but owns nothing and can go nowhere.
 *
 * `createWorkspace` validates only that a name is present. Everything else it hands straight to
 * Postgres, and `organizations.name` is VARCHAR(255) (V1_init_schema.sql) — so an over-long name is
 * a failed insert surfacing raw, which is the same defect shape as the custom-field name that used
 * to 500 past VARCHAR(160) and the `NaN` that used to reach a LIMIT clause. ONB-A-04 is the test for
 * it. The bound now lives in one shared validator (validateWorkspaceName) used by all three paths
 * that write organizations.name — this route, /api/onboarding/org-and-project, and the rename —
 * because only the rename had ever checked it, and the two create paths are the ones a new account
 * actually goes through.
 *
 * The suite seeds its own workspace-less users rather than driving signup/start, deliberately:
 * signup/start is IP rate-limited and every worker looks like the same caller, so spending the
 * allowance here would make api/signup.spec.ts's and api/auth.spec.ts's rate-limit tests fail
 * depending on file order. seedFixtureUser writes the row directly and costs nothing.
 */

test.describe("onboarding — naming the first workspace", () => {
  let anon: APIRequestContext;
  /** Every address this file seeded, torn down in afterAll whatever happened. */
  const seeded: string[] = [];

  const skipReason = dbControlAvailable()
    ? null
    : "needs `docker compose exec postgres psql` to seed a user who belongs to no workspace";

  test.beforeAll(async () => {
    anon = await anonymousContext();
  });

  test.afterAll(async () => {
    if (!skipReason) for (const email of seeded) purge(email);
    await anon?.dispose();
  });

  test.beforeEach(() => {
    test.skip(skipReason !== null, skipReason ?? "");
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * A logged-in caller who belongs to no workspace — the state /onboarding exists to resolve.
   *
   * seedFixtureUser sets FIXTURE_PASSWORD, so loginAs works on them like any tenant user.
   */
  async function freshUser(label: string): Promise<{ email: string; api: APIRequestContext; userId: string }> {
    const email = testAddress(`onboarding-${label}`);
    seeded.push(email);
    const user = seedFixtureUser(email, "EndToEnd Onboarding User");
    return { email, api: await loginAs(user), userId: user.userId };
  }

  /** Drops the user and any workspace they created, so a re-run starts from the same place. */
  function purge(email: string): void {
    const orgIds = scalar(
      "SELECT COALESCE(string_agg(DISTINCT quote_literal(om.organization_id::text), ','), '') " +
        "FROM organization_members om JOIN users u ON u.id = om.user_id " +
        `WHERE u.email = ${literal(email.toLowerCase())};`,
    );
    if (orgIds) {
      exec(`DELETE FROM project_members WHERE project_id IN (SELECT id FROM projects WHERE organization_id IN (${orgIds}));`);
      exec(`DELETE FROM knowledge_folders WHERE project_id IN (SELECT id FROM projects WHERE organization_id IN (${orgIds}));`);
      execAllowingAuditImmutability(`DELETE FROM projects WHERE organization_id IN (${orgIds});`);
      exec(`DELETE FROM organization_members WHERE organization_id IN (${orgIds});`);
      exec(`UPDATE users SET active_organization_id = NULL, default_project_id = NULL WHERE email = ${literal(email.toLowerCase())};`);
      execAllowingAuditImmutability(`DELETE FROM organizations WHERE id IN (${orgIds});`);
    }
    // detachUserByEmail clears the memberships; the row itself goes too, because these addresses are
    // timestamped and would otherwise accumulate one dead user per run on the persistent volume.
    detachUserByEmail(email);
    execAllowingAuditImmutability(`DELETE FROM users WHERE email = ${literal(email.toLowerCase())};`);
  }

  function ownedOrgName(email: string): string {
    return scalar(
      "SELECT COALESCE(o.name, '') FROM organizations o " +
        "JOIN organization_members om ON om.organization_id = o.id " +
        "JOIN users u ON u.id = om.user_id " +
        `WHERE u.email = ${literal(email.toLowerCase())} AND om.role = 'owner' LIMIT 1;`,
    );
  }

  function orgCountFor(email: string): number {
    return Number(
      scalar(
        "SELECT COUNT(*) FROM organization_members om JOIN users u ON u.id = om.user_id " +
          `WHERE u.email = ${literal(email.toLowerCase())};`,
      ),
    );
  }

  // ─── The happy path ────────────────────────────────────────────────────────

  test("ONB-A-01 a brand-new user names a workspace and becomes its owner", { tag: '@tesbo.testId("TES-TC-936")' }, async () => {
    const { email, api, userId } = await freshUser("happy");
    try {
      const name = `E2E Onboarding Org ${Date.now()}`;
      const res = await api.post("/api/onboarding/workspace", { data: { orgName: name }, failOnStatusCode: false });

      expect(res.status(), `creating the first workspace — ${await res.text()}`).toBeLessThan(300);
      const body = await res.json();
      expect(body.organizationId).toMatch(/^[0-9a-f-]{36}$/);

      // Persisted state, not just the response: the row, the ownership, and the active workspace
      // pointer the app reads on the next request.
      expect(ownedOrgName(email)).toBe(name);
      expect(
        scalar(
          `SELECT role FROM organization_members WHERE organization_id = ${literal(body.organizationId)} AND user_id = ${literal(userId)};`,
        ),
      ).toBe("owner");
      expect(
        scalar(`SELECT COALESCE(active_organization_id::text, '') FROM users WHERE id = ${literal(userId)};`),
      ).toBe(body.organizationId);
    } finally {
      await api.dispose();
    }
  });

  test("ONB-A-02 the workspace is immediately readable through GET /api/workspace", { tag: '@tesbo.testId("TES-TC-937")' }, async () => {
    const { api } = await freshUser("readback");
    try {
      const name = `E2E Onboarding Readback ${Date.now()}`;
      const created = await api.post("/api/onboarding/workspace", { data: { orgName: name } });
      expect(created.ok()).toBeTruthy();

      // The onboarding screen redirects straight into the app, which reads this — a workspace that
      // saved but does not read back leaves the user on a broken first screen.
      const workspace = await api.get("/api/workspace");
      expect(workspace.status(), await workspace.text()).toBe(200);
      expect((await workspace.json()).name).toBe(name);
    } finally {
      await api.dispose();
    }
  });

  test("ONB-A-03 two users may name their workspaces identically", { tag: '@tesbo.testId("TES-TC-938")' }, async () => {
    const first = await freshUser("dup-a");
    const second = await freshUser("dup-b");
    try {
      // The slug is derived from the name and is unique, so the second insert collides and
      // insertOrganization retries with a suffix. Both must still end up owning a workspace.
      const name = `E2E Onboarding Shared Name ${Date.now()}`;
      for (const who of [first, second]) {
        const res = await who.api.post("/api/onboarding/workspace", {
          data: { orgName: name },
          failOnStatusCode: false,
        });
        expect(res.status(), `${who.email} — ${await res.text()}`).toBeLessThan(300);
      }

      expect(ownedOrgName(first.email)).toBe(name);
      expect(ownedOrgName(second.email)).toBe(name);
      // Two distinct records, not one shared one.
      expect(
        Number(scalar(`SELECT COUNT(*) FROM organizations WHERE name = ${literal(name)};`)),
      ).toBe(2);
    } finally {
      await first.api.dispose();
      await second.api.dispose();
    }
  });

  // ─── Refusals: each must be a 4xx, never a 500 ─────────────────────────────

  test("ONB-A-04 a name longer than the column is refused with a 400, not a 500", { tag: '@tesbo.testId("TES-TC-939")' }, async () => {
    const { email, api } = await freshUser("toolong");
    try {
      // organizations.name is VARCHAR(255). createWorkspace does not check the length, so the
      // over-length value reaches Postgres and the failed insert surfaces as a 500.
      const res = await api.post("/api/onboarding/workspace", {
        data: { orgName: "W".repeat(256) },
        failOnStatusCode: false,
      });

      expect(res.status(), `256-character workspace name — ${await res.text()}`).toBe(400);
      expect(orgCountFor(email), "a refused name must not half-create a workspace").toBe(0);

      // The boundary itself is legal and must still work.
      const atLimit = await api.post("/api/onboarding/workspace", {
        data: { orgName: "W".repeat(255) },
        failOnStatusCode: false,
      });
      expect(atLimit.status(), `255-character name — ${await atLimit.text()}`).toBeLessThan(300);
    } finally {
      await api.dispose();
    }
  });

  test("ONB-A-04b the org-and-project path bounds the workspace name too", { tag: '@tesbo.testId("TES-TC-1183")' }, async () => {
    /*
     * The same VARCHAR(255) column, reached through the other create route. Only the rename path
     * had ever checked the length, so both create paths — the two a new account actually goes
     * through — could still 500 on it.
     */
    const { email, api } = await freshUser("orgproject");
    try {
      const res = await api.post("/api/onboarding/org-and-project", {
        data: { orgName: "W".repeat(256), projectName: "E2E Onboarding Project" },
        failOnStatusCode: false,
      });
      expect(res.status(), `256-character workspace name — ${await res.text()}`).toBe(400);
      expect(orgCountFor(email), "a refused name must not half-create a workspace").toBe(0);

      const atLimit = await api.post("/api/onboarding/org-and-project", {
        data: { orgName: "W".repeat(255), projectName: "E2E Onboarding Project" },
        failOnStatusCode: false,
      });
      expect(atLimit.status(), `255-character name — ${await atLimit.text()}`).toBeLessThan(300);
    } finally {
      await api.dispose();
    }
  });

  test("ONB-A-05 a missing, blank or whitespace-only name is refused and writes nothing", { tag: '@tesbo.testId("TES-TC-940")' }, async () => {
    const { email, api } = await freshUser("blank");
    try {
      for (const orgName of [undefined, "", "   ", "\t\n"]) {
        const res = await api.post("/api/onboarding/workspace", {
          data: orgName === undefined ? {} : { orgName },
          failOnStatusCode: false,
        });
        expect(res.status(), `orgName=${JSON.stringify(orgName)} — ${await res.text()}`).toBe(400);
      }
      expect(orgCountFor(email)).toBe(0);
    } finally {
      await api.dispose();
    }
  });

  test("ONB-A-06 a name is trimmed rather than stored with its padding", { tag: '@tesbo.testId("TES-TC-941")' }, async () => {
    const { email, api } = await freshUser("trim");
    try {
      const name = `E2E Onboarding Trim ${Date.now()}`;
      const res = await api.post("/api/onboarding/workspace", {
        data: { orgName: `   ${name}   ` },
        failOnStatusCode: false,
      });
      expect(res.status(), await res.text()).toBeLessThan(300);

      expect(ownedOrgName(email)).toBe(name);
    } finally {
      await api.dispose();
    }
  });

  test("ONB-A-07 an anonymous caller cannot create a workspace", { tag: '@tesbo.testId("TES-TC-942")' }, async () => {
    const before = Number(scalar("SELECT COUNT(*) FROM organizations;"));

    const res = await anon.post("/api/onboarding/workspace", {
      data: { orgName: `E2E Onboarding Anon ${Date.now()}` },
      failOnStatusCode: false,
    });

    expect(res.status(), await res.text()).toBe(401);
    expect(Number(scalar("SELECT COUNT(*) FROM organizations;")), "nothing may be created").toBe(before);
  });

  test("ONB-A-08 a malformed body is a 400, never an unhandled 500", { tag: '@tesbo.testId("TES-TC-943")' }, async () => {
    const { email, api } = await freshUser("malformed");
    try {
      const bodies: Record<string, unknown>[] = [
        { orgName: null },
        { orgName: 42 },
        { orgName: { nested: "object" } },
        { orgName: ["array"] },
        { orgName: "Fine", country: "not-a-country-code" },
      ];
      for (const data of bodies) {
        const res = await api.post("/api/onboarding/workspace", { data, failOnStatusCode: false });
        expect(res.status(), `${JSON.stringify(data)} — ${await res.text()}`).toBeLessThan(500);
      }
      // The last body is otherwise valid, so at most one workspace can have been created.
      expect(orgCountFor(email)).toBeLessThanOrEqual(1);
    } finally {
      await api.dispose();
    }
  });
});
