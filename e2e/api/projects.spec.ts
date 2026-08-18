import { expect, test, type APIRequestContext } from "@playwright/test";
import { env } from "../utils/env";
import { dbControlAvailable } from "../utils/psql";
import {
  backdate,
  createBug,
  createProject,
  createSuite,
  createTestCase,
  deleteProjects,
  getDashboard,
  listRuns,
  screensApi,
  screensSuiteSkipReason,
  screensTenant,
  seedJiraRequirements,
  seedRun,
  softDeleteExecutions,
  uniqueSuffix,
} from "../utils/screens-tenant";

test.describe("project CRUD", () => {
  test("creates a project from just a name and derives a key from it", async ({ request }) => {
    // projectKey() uppercases, strips non-alphanumerics, then keeps only the first 16 chars —
    // so the name must stay short enough that the full (fast-changing) timestamp survives
    // that truncation. A longer prefix like "E2E Project" would eat the budget and leave only
    // the timestamp's slow-changing leading digits, colliding across reruns within the same
    // ~2.8-hour window (organization_id, key) is uniquely constrained forever, even for
    // archived projects.
    const name = `E2E ${Date.now()}`;
    const createRes = await request.post("/api/projects", { data: { name } });
    expect(createRes.ok()).toBeTruthy();
    const created = await createRes.json();
    expect(created.id).toBeTruthy();
    expect(created.name).toBe(name);
    expect(created.key).toMatch(/^[A-Z0-9]{1,16}$/);
    expect(created.projectType).toBe("tesbox");

    await request.delete(`/api/projects/${created.id}`);
  });

  test("creates a project with an explicit key, description and projectType", async ({ request }) => {
    const suffix = Date.now().toString().slice(-8);
    const name = `E2E Full Project ${suffix}`;
    const createRes = await request.post("/api/projects", {
      data: { name, key: `e2e${suffix}`, description: "Created by the e2e suite", projectType: "manual" },
    });
    expect(createRes.ok()).toBeTruthy();
    const created = await createRes.json();
    // projectKey() uppercases and strips non-alphanumerics before storing.
    expect(created.key).toBe(`E2E${suffix}`);
    expect(created.projectType).toBe("manual");

    const getRes = await request.get(`/api/projects/${created.id}`);
    expect((await getRes.json()).description).toBe("Created by the e2e suite");

    await request.delete(`/api/projects/${created.id}`);
  });

  test("rejects creating a project without a name", async ({ request }) => {
    const res = await request.post("/api/projects", { data: {}, failOnStatusCode: false });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/name/i);
  });

  test("rejects creating a project whose key collides with an existing one", async ({ request }) => {
    const suffix = Date.now().toString().slice(-8);
    const key = `DUPE${suffix}`;

    const firstRes = await request.post("/api/projects", { data: { name: `Dup A ${suffix}`, key } });
    expect(firstRes.ok()).toBeTruthy();
    const first = await firstRes.json();

    // Known rough edge, pinned deliberately: (organization_id, key) is unique at the DB level
    // but createProject() doesn't catch that constraint violation, so a collision falls through
    // to the generic unhandled-exception handler as a 500 rather than a clean 4xx. If that's
    // ever fixed, this assertion should be tightened to the new status rather than loosened.
    const secondRes = await request.post("/api/projects", {
      data: { name: `Dup B ${suffix}`, key },
      failOnStatusCode: false,
    });
    expect(secondRes.ok()).toBeFalsy();

    await request.delete(`/api/projects/${first.id}`);
  });

  test("supports the read -> update -> delete lifecycle", async ({ request }) => {
    const suffix = Date.now().toString().slice(-8);
    const name = `E2E Lifecycle Project ${suffix}`;
    // Explicit key: the name alone is too long for projectKey()'s 16-char budget to retain any
    // of the timestamp (see the "derives a key from it" test above for why that matters).
    const createRes = await request.post("/api/projects", { data: { name, key: `E2ELIFE${suffix}` } });
    const created = await createRes.json();

    const getRes = await request.get(`/api/projects/${created.id}`);
    expect(getRes.ok()).toBeTruthy();
    expect((await getRes.json()).name).toBe(name);

    const updatedName = `${name} (renamed)`;
    const patchRes = await request.patch(`/api/projects/${created.id}`, {
      data: { name: updatedName, description: "updated description", settings: { foo: "bar" } },
    });
    expect(patchRes.ok()).toBeTruthy();

    const getAfterUpdateRes = await request.get(`/api/projects/${created.id}`);
    const afterUpdate = await getAfterUpdateRes.json();
    expect(afterUpdate.name).toBe(updatedName);
    expect(afterUpdate.description).toBe("updated description");
    expect(afterUpdate.settings).toMatchObject({ foo: "bar" });

    const listRes = await request.get("/api/projects");
    const list = await listRes.json();
    expect(list.some((p: { id: string }) => p.id === created.id)).toBeTruthy();

    const deleteRes = await request.delete(`/api/projects/${created.id}`);
    expect(deleteRes.ok()).toBeTruthy();

    const getAfterDeleteRes = await request.get(`/api/projects/${created.id}`, {
      failOnStatusCode: false,
    });
    expect(getAfterDeleteRes.status()).toBe(404);

    const listAfterDeleteRes = await request.get("/api/projects");
    const listAfterDelete = await listAfterDeleteRes.json();
    expect(listAfterDelete.some((p: { id: string }) => p.id === created.id)).toBeFalsy();
  });

  test("update validates name and description instead of blanking the name", async ({ request }) => {
    // This used to assert the opposite: updateProject() had no "name required" check, so
    // PATCH {name: ""} blanked the name (COALESCE only skips null/undefined, and "" is neither),
    // and the spec documented that gap. validateProjectFields() is now shared by
    // createProject/updateProject, so the gap is closed and an empty name is a 400 that changes
    // nothing. Boundaries are asserted here too, so a regression in either direction shows up.
    const suffix = Date.now().toString().slice(-8);
    const name = `E2E Validated Project ${suffix}`;
    const createRes = await request.post("/api/projects", { data: { name, key: `E2EVAL${suffix}` } });
    const created = await createRes.json();

    try {
      // Each rejected payload must leave the stored name untouched, not partially applied.
      for (const badName of ["", "   ", "ab"]) {
        const res = await request.patch(`/api/projects/${created.id}`, {
          data: { name: badName },
          failOnStatusCode: false,
        });
        expect(res.status()).toBe(400);
        const getRes = await request.get(`/api/projects/${created.id}`);
        expect((await getRes.json()).name).toBe(name);
      }

      const tooLongName = await request.patch(`/api/projects/${created.id}`, {
        data: { name: "x".repeat(256) },
        failOnStatusCode: false,
      });
      expect(tooLongName.status()).toBe(400);

      const tooLongDescription = await request.patch(`/api/projects/${created.id}`, {
        data: { description: "d".repeat(501) },
        failOnStatusCode: false,
      });
      expect(tooLongDescription.status()).toBe(400);

      // The max-length boundary itself is allowed — 255 passes, 256 (above) does not.
      const atMaxName = `${"y".repeat(255)}`;
      const okRes = await request.patch(`/api/projects/${created.id}`, { data: { name: atMaxName } });
      expect(okRes.ok()).toBeTruthy();
      const afterOk = await request.get(`/api/projects/${created.id}`);
      expect((await afterOk.json()).name).toBe(atMaxName);
    } finally {
      await request.delete(`/api/projects/${created.id}`, { failOnStatusCode: false });
    }
  });

  test("updating or deleting a project that doesn't exist returns 404", async ({ request }) => {
    const missingId = "00000000-0000-0000-0000-000000000000";

    const patchRes = await request.patch(`/api/projects/${missingId}`, {
      data: { name: "nope" },
      failOnStatusCode: false,
    });
    expect(patchRes.status()).toBe(404);

    const deleteRes = await request.delete(`/api/projects/${missingId}`, { failOnStatusCode: false });
    expect(deleteRes.status()).toBe(404);
  });
});

/*
 * ── GET /api/projects/:projectId/dashboard ──
 *
 * Runs against the disposable screens tenant, not account A: every assertion here is arithmetic
 * over a project's whole contents, which is only deterministic when the project was built by this
 * test and nothing else is writing to it. See utils/screens-tenant.ts.
 */
test.describe("project dashboard summary", () => {
  const tenant = screensTenant();
  const skipReason = screensSuiteSkipReason(tenant);

  test.skip(!!skipReason, skipReason ?? "");

  let api: APIRequestContext;

  test.beforeAll(async () => {
    api = await screensApi();
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  test("DSH-A-01/02 a brand-new project reports the full contract, zeroed, with no invented rates", async () => {
    const project = await createProject(api);
    try {
      const summary = await getDashboard(api, project.id);

      expect(summary).toEqual({
        testCases: { total: 0, addedThisWeek: 0 },
        passRate: { value: null, deltaThisWeek: null },
        openBugs: { total: 0, bySeverity: { Critical: 0, High: 0, Medium: 0, Low: 0 } },
        coverage: { pct: null, totalRequirements: 0 },
        plans: 0,
        suites: 0,
        activeRuns: 0,
      });
      // Nothing has been executed, so a rate would be a fabrication — null, never 0.
      expect(summary.passRate.value).toBeNull();
      expect(summary.coverage.pct).toBeNull();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-03 testCases.total matches the list endpoint and excludes soft-deleted cases", async () => {
    const project = await createProject(api);
    try {
      const kept = await createTestCase(api, project.id);
      const removed = await createTestCase(api, project.id);
      expect((await getDashboard(api, project.id)).testCases.total).toBe(2);

      await api.delete(`/api/projects/${project.id}/testcases/${removed.id}`);

      const summary = await getDashboard(api, project.id);
      const listTotal = Number(
        (await api.get(`/api/projects/${project.id}/testcases`)).headers()["x-total-count"],
      );
      expect(summary.testCases.total).toBe(1);
      expect(summary.testCases.total).toBe(listTotal);
      expect(kept.id).toBeTruthy();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-04 addedThisWeek counts the last 7 days only", async () => {
    test.skip(!dbControlAvailable(), "needs psql access to backdate a test case past the 7-day window");
    const project = await createProject(api);
    try {
      const recent = await createTestCase(api, project.id);
      const old = await createTestCase(api, project.id);
      backdate("testcases", "created_at", [old.id], "8 days");

      const summary = await getDashboard(api, project.id);
      expect(summary.testCases.total).toBe(2);
      expect(summary.testCases.addedThisWeek).toBe(1);
      expect(recent.id).toBeTruthy();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-05 passRate divides by executed cases, leaving Untested out of the denominator", async () => {
    const project = await createProject(api);
    try {
      // 3 passed, 1 failed, 2 untested → 3/4 executed = 75%, not 3/6 = 50%.
      await seedRun(api, project.id, {
        statuses: ["Passed", "Passed", "Passed", "Failed", "Untested", "Untested"],
      });

      expect((await getDashboard(api, project.id)).passRate.value).toBe(75);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-06 a run with nothing executed reports no pass rate rather than 0%", async () => {
    const project = await createProject(api);
    try {
      await seedRun(api, project.id, { statuses: ["Untested", "Untested", "Untested"] });

      expect((await getDashboard(api, project.id)).passRate.value).toBeNull();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-07 deltaThisWeek stays null while either comparison window is empty", async () => {
    const project = await createProject(api);
    try {
      // Everything executed just now: the recent window has data, the prior one has none.
      await seedRun(api, project.id, { statuses: ["Passed", "Failed"] });

      const summary = await getDashboard(api, project.id);
      expect(summary.passRate.value).toBe(50);
      expect(summary.passRate.deltaThisWeek).toBeNull();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-08 deltaThisWeek compares the last 7 days against the 7 before them", async () => {
    test.skip(!dbControlAvailable(), "needs psql access to place executions in the prior 7-day window");
    const project = await createProject(api);
    try {
      // Prior window: 1 of 2 passed = 50%. Recent window: 2 of 2 passed = 100%. Delta = +50.
      const prior = await seedRun(api, project.id, { statuses: ["Passed", "Failed"] });
      backdate("executions", "executed_at", prior.executionIds, "10 days");
      await seedRun(api, project.id, { statuses: ["Passed", "Passed"] });

      expect((await getDashboard(api, project.id)).passRate.deltaThisWeek).toBe(50);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-09 openBugs counts Open and Reopened, and nothing else", async () => {
    const project = await createProject(api);
    try {
      await createBug(api, project.id, { severity: "Critical" });
      await createBug(api, project.id, { severity: "High", status: "Reopened" });
      await createBug(api, project.id, { severity: "Low", status: "Closed" });
      await createBug(api, project.id, { severity: "Medium", status: "In Progress" });

      const summary = await getDashboard(api, project.id);
      expect(summary.openBugs.total).toBe(2);
      expect(summary.openBugs.bySeverity).toEqual({ Critical: 1, High: 1, Medium: 0, Low: 0 });
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-10 a severity outside the four buckets is refused with a validation error, not a 500", async () => {
    const project = await createProject(api);
    try {
      // The dashboard's bySeverity has exactly four buckets, so a fifth severity would be counted
      // by the bugs list and dropped by the dashboard. It can't reach the database — V67 added
      // bugs_severity_check — but the constraint violation surfaces raw: the API answers 500 with
      // "Internal server error" instead of naming the offending field. An unknown enum value is
      // caller error, so this should be a 400 the UI can render against the severity field.
      const res = await api.post(`/api/projects/${project.id}/bugs`, {
        data: { title: `E2E Screens Bad Severity ${uniqueSuffix()}`, severity: "Trivial" },
        failOnStatusCode: false,
      });

      expect(res.status()).toBe(400);
      expect((await getDashboard(api, project.id)).openBugs.total).toBe(0);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-11 activeRuns counts In Progress runs only", async () => {
    const project = await createProject(api);
    try {
      await seedRun(api, project.id, { statuses: ["Passed"], status: "In Progress" });
      await seedRun(api, project.id, { statuses: ["Passed"], status: "Completed" });
      await seedRun(api, project.id, { statuses: ["Passed"] }); // Planning, the create default

      expect((await getDashboard(api, project.id)).activeRuns).toBe(1);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-12 coverage is null with no requirements, and a real percentage once they exist", async () => {
    test.skip(!dbControlAvailable(), "needs psql access to seed Jira requirements (no API route exists)");
    const project = await createProject(api);
    try {
      const before = await getDashboard(api, project.id);
      expect(before.coverage).toEqual({ pct: null, totalRequirements: 0 });

      const keys = [`E2ESCR-${uniqueSuffix()}`, `E2ESCR-${uniqueSuffix()}`, `E2ESCR-${uniqueSuffix()}`];
      seedJiraRequirements(tenant!.organizationId, project.id, keys);
      // One of the three requirements gets a test case pointing at it.
      await createTestCase(api, project.id, { jiraIssueKey: keys[0] } as never);

      const after = await getDashboard(api, project.id);
      expect(after.coverage.totalRequirements).toBe(3);
      expect(after.coverage.pct).toBe(33);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-13 suites and plans match their own list endpoints", async () => {
    const project = await createProject(api);
    try {
      await createSuite(api, project.id);
      await createSuite(api, project.id);
      await api.post(`/api/projects/${project.id}/plans`, { data: { name: `E2E Screens Plan ${Date.now()}` } });

      const summary = await getDashboard(api, project.id);
      const suites = await (await api.get(`/api/projects/${project.id}/suites`)).json();
      const plans = await (await api.get(`/api/projects/${project.id}/plans`)).json();

      expect(summary.suites).toBe(suites.length);
      expect(summary.plans).toBe(plans.length);
      expect(summary.plans).toBe(1);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-14 a caller with no session is refused and gets none of the summary", async ({ playwright }) => {
    // An explicitly empty storage state, not just an omitted one: playwright.config.ts sets a
    // global `use.storageState`, and leaving it unset here yields account A's cookies rather than
    // an anonymous caller — which would quietly turn this into a second copy of DSH-A-15.
    const anonymous = await playwright.request.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });
    try {
      const res = await anonymous.get(`/api/projects/${tenant!.projectId}/dashboard`, {
        failOnStatusCode: false,
      });

      // The refusal is what matters, and it holds. The code does not: these legacy project routes
      // answer a sessionless caller with 400 (requireUser rejecting a missing user id) where 401
      // is the correct status — pinned here so changing it to 401 is a deliberate edit.
      expect(res.status()).toBe(400);
      expect(await res.text()).not.toContain("passRate");
    } finally {
      await anonymous.dispose();
    }
  });

  test("DSH-A-15 another tenant cannot read this project's dashboard", async ({ request }) => {
    // `request` here is account A — a real, fully authenticated caller from a different workspace.
    const res = await request.get(`/api/projects/${tenant!.projectId}/dashboard`, {
      failOnStatusCode: false,
    });
    expect([403, 404]).toContain(res.status());
  });

  test("DSH-A-16 a missing or malformed project id fails cleanly, never with a 500", async () => {
    const missing = await api.get("/api/projects/00000000-0000-0000-0000-000000000000/dashboard", {
      failOnStatusCode: false,
    });
    expect([403, 404]).toContain(missing.status());

    const malformed = await api.get("/api/projects/not-a-uuid/dashboard", { failOnStatusCode: false });
    expect(malformed.status()).toBeLessThan(500);
  });

  test("DSH-A-17 the dashboard disappears with the project", async () => {
    const project = await createProject(api);
    await getDashboard(api, project.id); // readable while it exists
    await api.delete(`/api/projects/${project.id}`);

    const res = await api.get(`/api/projects/${project.id}/dashboard`, { failOnStatusCode: false });
    expect([403, 404]).toContain(res.status());
  });

  test("DSH-A-19 the per-run status counters add up to totalCases", async () => {
    const project = await createProject(api);
    try {
      const run = await seedRun(api, project.id, {
        statuses: ["Passed", "Failed", "Blocked", "Skipped", "Untested", "Retest"],
      });

      const listed = (await listRuns(api, project.id)).find((r) => r.id === run.cycleId)!;
      const bucketed =
        listed.passed + listed.failed + listed.blocked + listed.skipped + listed.untested;

      expect(listed.totalCases).toBe(6);
      // Retest is a status the API accepts (see executions.spec.ts) but listCycles has no bucket
      // for, so it lands in totalCases and in none of the counters the UI renders.
      expect(bucketed).toBe(listed.totalCases);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-20 a Retest execution is treated the same way by the run list and the dashboard", async () => {
    const project = await createProject(api);
    try {
      const run = await seedRun(api, project.id, { statuses: ["Passed", "Retest"] });

      const listed = (await listRuns(api, project.id)).find((r) => r.id === run.cycleId)!;
      const summary = await getDashboard(api, project.id);

      /*
       * Two readings of the same two executions, and they now agree: a case sent back for retest
       * has no settled result, so it sits in the run list's untested bucket and stays out of the
       * dashboard's executed denominator. One of the two cases has actually been executed, and it
       * passed, so the headline reads 100%.
       *
       * This previously asserted the divergence instead — 0 in every bucket but passed, and a
       * dashboard reading 1/2 = 50%. That was the defect DSH-A-19 reports from the other side: the
       * counters summed to less than totalCases, and a Retest quietly dragged the pass rate down
       * while changing nothing visible on the run. Fixing one required fixing both.
       */
      expect(listed.passed).toBe(1);
      expect(listed.untested).toBe(1);
      expect(listed.failed + listed.blocked + listed.skipped).toBe(0);
      expect(summary.passRate.value).toBe(100);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-21 a soft-deleted execution disappears from both the dashboard and the run list", async () => {
    test.skip(!dbControlAvailable(), "needs psql access — executions have no DELETE route");
    const project = await createProject(api);
    try {
      const run = await seedRun(api, project.id, { statuses: ["Passed", "Failed"] });
      expect((await getDashboard(api, project.id)).passRate.value).toBe(50);

      const failedExecution = run.executionIds[1];
      softDeleteExecutions([failedExecution]);

      const summary = await getDashboard(api, project.id);
      const listed = (await listRuns(api, project.id)).find((r) => r.id === run.cycleId)!;

      // The dashboard reads executions_active (the deleted_at IS NULL view from V64), so the row
      // is gone and the rate climbs to 1 of 1 passed.
      expect(summary.passRate.value).toBe(100);
      // The run list agrees now. This used to assert the opposite — listCycles read the raw
      // executions table, so the deleted row stayed in its counters and the two screens disagreed
      // about the same run permanently. listCycles joins `AND e.deleted_at IS NULL` and counts off
      // e.id, and every plan roll-up was moved onto that same rule (EXECUTION_BUCKET_COUNTS) when
      // "Overall progress percentage not matching" was fixed, so a deleted result is now nowhere.
      expect(listed.failed).toBe(0);
      expect(listed.totalCases).toBe(1);
      expect(listed.passed).toBe(1);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("DSH-A-22 a run with no test cases reports nothing to execute", async () => {
    const project = await createProject(api);
    try {
      const run = await seedRun(api, project.id, { statuses: [] });

      const listed = (await listRuns(api, project.id)).find((r) => r.id === run.cycleId)!;
      expect(listed.totalCases).toBe(0);
      // This used to be pinned at 1, recording the defect: the LEFT JOIN emits one all-NULL row for
      // a cycle with no items, and an untested bucket counted with COUNT(*) FILTER (...) scored that
      // row as a case that does not exist. The pin said fixing it had to be a deliberate change —
      // this is that change, made everywhere at once. Counting the buckets off e.id (see
      // EXECUTION_BUCKET_COUNTS) keeps the placeholder row out, so an empty run claims nothing on
      // the run list, and a plan holding one no longer reports more untested cases than it has
      // cases. That was the "Overall progress percentage not matching" report.
      expect(listed.untested).toBe(0);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });
});
