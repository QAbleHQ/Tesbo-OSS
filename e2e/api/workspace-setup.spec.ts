import { expect, test, type APIRequestContext } from "@playwright/test";
import { testAddress } from "../utils/env";
import { literal, scalar } from "../utils/psql";
import {
  anonymousContext,
  detachUserByEmail,
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  seedFixtureUser,
  type RbacTenant,
} from "../utils/rbac-tenant";

/*
 * The two workspace-level endpoints Wave 1 left uncovered: first-workspace creation and the
 * workspace-wide analytics rollup.
 *
 * POST /api/onboarding/workspace is the "you have an account but no workspace" path — distinct from
 * /api/onboarding/org-and-project (which global-setup uses to bootstrap fixtures) in that it makes a
 * workspace with no project in it. It also repoints the caller's active workspace, so it is only
 * ever driven here as a freshly seeded user who has nothing to lose.
 */

test.describe("workspace setup and analytics", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let anon: APIRequestContext;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("setup");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    anon = await anonymousContext();
  });

  test.afterAll(async () => {
    await Promise.all([asOwner, anon].filter(Boolean).map((ctx) => ctx.dispose()));
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  /** How many soft-deleted projects this workspace is carrying, for the failure message below. */
  function archivedProjectCount(organizationId: string): number {
    return Number(
      scalar(
        `SELECT COUNT(*) FROM projects WHERE organization_id = ${literal(organizationId)} ` +
          "AND archived_at IS NOT NULL;",
      ),
    );
  }

  // ─── First workspace ───────────────────────────────────────────────────────

  test("a user with no workspace can create their first one and owns it", async () => {
    const email = testAddress("setup-newuser");
    const user = seedFixtureUser(email, "E2E Fresh User");
    const api = await loginAs(user);
    try {
      // Nothing to belong to yet — the app has to send this user to onboarding, not to a 500.
      const before = await api.get("/api/workspace", { failOnStatusCode: false });
      expect(before.status()).toBe(404);

      const name = `E2E Setup Workspace ${Date.now()}`;
      const res = await api.post("/api/onboarding/workspace", {
        data: { orgName: name, country: "US" },
        failOnStatusCode: false,
      });
      expect(res.ok(), `creating the first workspace failed: ${res.status()} ${await res.text()}`).toBeTruthy();
      const { organizationId } = await res.json();
      expect(organizationId).toBeTruthy();

      // The creator has to come out of this as owner, and it has to be their active workspace —
      // otherwise onboarding completes into a workspace the user can't administer or reach.
      const after = await api.get("/api/workspace");
      const workspace = await after.json();
      expect(workspace.id).toBe(organizationId);
      expect(workspace.name).toBe(name);
      expect(workspace.role).toBe("owner");

      // A workspace with no project is the expected end state of this path — the project comes next.
      const projects = await (await api.get("/api/projects")).json();
      const list: any[] = Array.isArray(projects) ? projects : (projects.projects ?? []);
      expect(list).toEqual([]);
    } finally {
      await api.dispose();
      detachUserByEmail(email);
    }
  });

  test("creating a workspace requires a name", async () => {
    const email = testAddress("setup-noname");
    const user = seedFixtureUser(email, "E2E No Name User");
    const api = await loginAs(user);
    try {
      for (const data of [{}, { orgName: "" }, { orgName: "   " }]) {
        const res = await api.post("/api/onboarding/workspace", { data, failOnStatusCode: false });
        expect(res.status(), `${JSON.stringify(data)} should be refused`).toBe(400);
      }
      // Still nothing created, so the user is where they started rather than in a nameless workspace.
      expect((await api.get("/api/workspace", { failOnStatusCode: false })).status()).toBe(404);
    } finally {
      await api.dispose();
      detachUserByEmail(email);
    }
  });

  test("creating a workspace needs a session", async () => {
    const res = await anon.post("/api/onboarding/workspace", {
      data: { orgName: `E2E Anon Workspace ${Date.now()}` },
      failOnStatusCode: false,
    });
    expect([400, 401]).toContain(res.status());
  });

  // ─── Workspace analytics ───────────────────────────────────────────────────

  test("workspace analytics reports coherent totals for the whole workspace", async () => {
    const res = await asOwner.get("/api/workspace/analytics");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    for (const key of [
      "projectCount",
      "testCaseCount",
      "suiteCount",
      "planCount",
      "cycleCount",
      "executionTotal",
    ]) {
      expect(typeof body[key], `${key} should be a number`).toBe("number");
      expect(body[key], `${key} should never be negative`).toBeGreaterThanOrEqual(0);
    }

    // The rollup has to describe the workspace the caller can actually see, so its project count
    // must match their own project list. analytics() counts `FROM projects WHERE organization_id`
    // with no archived_at filter — unlike testCaseCount, which reads the soft-delete-aware
    // testcases_active view — so every archived project keeps inflating this number forever.
    const projects = await (await asOwner.get("/api/projects")).json();
    const list: any[] = Array.isArray(projects) ? projects : (projects.projects ?? []);
    expect(
      body.projectCount,
      `projectCount should count the ${list.length} live project(s) and exclude the ` +
        `${archivedProjectCount(tenant!.organizationId)} archived one(s)`,
    ).toBe(list.length);

    // executionStatus is a bucket-per-status map, and its values must add up to the reported total.
    const summed = Object.values(body.executionStatus as Record<string, number>).reduce(
      (a, b) => a + b,
      0,
    );
    expect(summed).toBe(body.executionTotal);
  });

  test("workspace analytics counts a new project, and stops counting an archived one", async () => {
    const suffix = Date.now().toString().slice(-8);
    const before = await (await asOwner.get("/api/workspace/analytics")).json();

    const created = await asOwner.post("/api/projects", {
      data: { name: `E2E Analytics Project ${suffix}`, key: `an${suffix}` },
      failOnStatusCode: false,
    });
    expect(created.ok()).toBeTruthy();
    const projectId = (await created.json()).id;

    try {
      const during = await (await asOwner.get("/api/workspace/analytics")).json();
      expect(during.projectCount).toBe(before.projectCount + 1);
    } finally {
      await asOwner.delete(`/api/projects/${projectId}`, { failOnStatusCode: false });
    }

    // Archiving is a soft delete; the rollup has to drop it or every deleted project keeps inflating
    // the workspace's numbers forever.
    const after = await (await asOwner.get("/api/workspace/analytics")).json();
    expect(after.projectCount).toBe(before.projectCount);
  });

  test("workspace analytics needs a session", async () => {
    const res = await anon.get("/api/workspace/analytics", { failOnStatusCode: false });
    expect([400, 401]).toContain(res.status());
  });
});
