import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { env } from "../utils/env";

const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));

test.describe("test cycle / run CRUD", () => {
  test("supports the create -> read -> update -> list -> delete lifecycle", { tag: '@tesbo.testId("TES-TC-170")' }, async ({ request }) => {
    const name = `E2E Cycle ${Date.now()}`;
    const created = await (
      await request.post(`/api/projects/${ctx.projectId}/cycles`, {
        data: { name, description: "Created by the e2e suite", environment: "staging", buildVersion: "1.2.3" },
      })
    ).json();

    try {
      expect(created.id).toBeTruthy();
      expect(created.status).toBe("Planning");
      expect(created.environment).toBe("staging");

      const getRes = await request.get(`/api/cycles/${created.id}`);
      expect(getRes.ok()).toBeTruthy();
      expect((await getRes.json()).buildVersion).toBe("1.2.3");

      const updatedName = `${name} (updated)`;
      const patchRes = await request.patch(`/api/cycles/${created.id}`, {
        data: { name: updatedName, status: "In Progress" },
      });
      expect(patchRes.ok()).toBeTruthy();

      const getAfterUpdateRes = await request.get(`/api/cycles/${created.id}`);
      const afterUpdate = await getAfterUpdateRes.json();
      expect(afterUpdate.name).toBe(updatedName);
      expect(afterUpdate.status).toBe("In Progress");

      const listRes = await request.get(`/api/projects/${ctx.projectId}/cycles`);
      const list = await listRes.json();
      expect(list.some((c: { id: string }) => c.id === created.id)).toBeTruthy();
    } finally {
      await request.delete(`/api/cycles/${created.id}`, { failOnStatusCode: false });
    }

    const getAfterDeleteRes = await request.get(`/api/cycles/${created.id}`, { failOnStatusCode: false });
    expect(getAfterDeleteRes.status()).toBe(404);
  });

  test("updateCycle's planId/clearPlan semantics: an omitted planId keeps it, clearPlan:true nulls it", { tag: '@tesbo.testId("TES-TC-171")' }, async ({
    request,
  }) => {
    const plan = await (
      await request.post(`/api/projects/${ctx.projectId}/plans`, {
        data: { name: `E2E Cycle Plan Link ${Date.now()}` },
      })
    ).json();
    const cycle = await (
      await request.post(`/api/projects/${ctx.projectId}/cycles`, {
        data: { name: `E2E Cycle Plan Link Cycle ${Date.now()}`, planId: plan.id },
      })
    ).json();

    try {
      expect(cycle.planId).toBe(plan.id);

      // Updating an unrelated field without sending planId must leave it untouched (unlike
      // updateSuite's parentId, this one IS COALESCE-guarded — legacy.service.ts:1855).
      await request.patch(`/api/cycles/${cycle.id}`, { data: { description: "unrelated update" } });
      const afterUnrelatedUpdate = await (await request.get(`/api/cycles/${cycle.id}`)).json();
      expect(afterUnrelatedUpdate.planId).toBe(plan.id);

      await request.patch(`/api/cycles/${cycle.id}`, { data: { clearPlan: true } });
      const afterClear = await (await request.get(`/api/cycles/${cycle.id}`)).json();
      expect(afterClear.planId).toBeNull();
    } finally {
      await request.delete(`/api/cycles/${cycle.id}`, { failOnStatusCode: false });
      await request.delete(`/api/plans/${plan.id}`, { failOnStatusCode: false });
    }
  });

  test("supports adding and removing test cases, auto-creating one execution per added case", { tag: '@tesbo.testId("TES-TC-172")' }, async ({
    request,
  }) => {
    const cycle = await (
      await request.post(`/api/projects/${ctx.projectId}/cycles`, {
        data: { name: `E2E Cycle Cases ${Date.now()}` },
      })
    ).json();
    const testcaseA = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: `E2E Cycle Case A ${Date.now()}` },
      })
    ).json();
    const testcaseB = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: `E2E Cycle Case B ${Date.now()}` },
      })
    ).json();

    try {
      await request.post(`/api/cycles/${cycle.id}/testcases`, {
        data: { testcaseIds: [testcaseA.id, testcaseB.id] },
      });

      const executionsRes = await request.get(`/api/cycles/${cycle.id}/executions`);
      const executions = await executionsRes.json();
      expect(executions).toHaveLength(2);
      expect(executions.every((e: { status: string }) => e.status === "Untested")).toBeTruthy();

      await request.delete(`/api/cycles/${cycle.id}/testcases/${testcaseA.id}`);

      const executionsAfterRes = await request.get(`/api/cycles/${cycle.id}/executions`);
      const executionsAfter = await executionsAfterRes.json();
      expect(executionsAfter).toHaveLength(1);
      expect(executionsAfter[0].testcaseId).toBe(testcaseB.id);
    } finally {
      await request.delete(`/api/cycles/${cycle.id}`, { failOnStatusCode: false });
      await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcaseA.id}`, {
        failOnStatusCode: false,
      });
      await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcaseB.id}`, {
        failOnStatusCode: false,
      });
    }
  });

  test("from-plan and from-cases creation are aliases for plain create — neither seeds cycle_items", { tag: '@tesbo.testId("TES-TC-173")' }, async ({
    request,
  }) => {
    // KNOWN GAP (documented, not test.fail() — a functional no-op, not a security issue):
    // legacy.controller.ts:363-370 routes createCycleFromPlan/createCycleFromCases to the exact
    // same legacy.createCycle(projectId, body) as the plain endpoint. Despite the names, neither
    // actually copies items from the plan or the given case IDs into cycle_items — pinned here so
    // a future "fix" is a deliberate, visible change rather than an accidental behavior shift.
    const plan = await (
      await request.post(`/api/projects/${ctx.projectId}/plans`, {
        data: { name: `E2E From-Plan Source ${Date.now()}` },
      })
    ).json();
    const testcase = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: `E2E From-Cases Source ${Date.now()}` },
      })
    ).json();
    await request.post(`/api/plans/${plan.id}/items`, { data: { testcaseId: testcase.id } });

    const fromPlanCycle = await (
      await request.post(`/api/projects/${ctx.projectId}/cycles/from-plan`, {
        data: { name: `E2E From-Plan Cycle ${Date.now()}`, planId: plan.id },
      })
    ).json();
    const fromCasesCycle = await (
      await request.post(`/api/projects/${ctx.projectId}/cycles/from-cases`, {
        data: { name: `E2E From-Cases Cycle ${Date.now()}`, testcaseIds: [testcase.id] },
      })
    ).json();

    try {
      const fromPlanExecutions = await (
        await request.get(`/api/cycles/${fromPlanCycle.id}/executions`)
      ).json();
      const fromCasesExecutions = await (
        await request.get(`/api/cycles/${fromCasesCycle.id}/executions`)
      ).json();
      expect(fromPlanExecutions).toHaveLength(0);
      expect(fromCasesExecutions).toHaveLength(0);
    } finally {
      await request.delete(`/api/cycles/${fromPlanCycle.id}`, { failOnStatusCode: false });
      await request.delete(`/api/cycles/${fromCasesCycle.id}`, { failOnStatusCode: false });
      await request.delete(`/api/plans/${plan.id}`, { failOnStatusCode: false });
      await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`, {
        failOnStatusCode: false,
      });
    }
  });
});

test.describe("linking test cases to a run at scale", () => {
  // Regression cover for the reported 524: linking used to issue three sequential statements per
  // test case, so a few hundred cases exceeded the edge proxy's timeout and, because each insert
  // autocommitted separately, only part of the selection survived. 300 is the size users reported
  // failing at.
  const CASE_COUNT = 300;

  test("adds 300 cases in one request, reports them consistently, and bulk-removes them", { tag: '@tesbo.testId("TES-TC-905")' }, async ({ request }) => {
    // Comfortably above what the batched path needs (~7s end to end locally) while still
    // failing rather than hanging if the per-row behaviour ever comes back.
    test.setTimeout(180_000);
    const stamp = Date.now();
    const cycle = await (
      await request.post(`/api/projects/${ctx.projectId}/cycles`, { data: { name: `E2E Bulk Link ${stamp}` } })
    ).json();

    const created = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases/bulk-create`, {
        data: {
          testcases: Array.from({ length: CASE_COUNT }, (_, i) => ({
            title: `E2E Bulk Link Case ${stamp}-${i}`,
            status: "Approved",
          })),
        },
      })
    ).json();
    const testcaseIds: string[] = created.created.map((c: { id: string }) => c.id);

    try {
      expect(created.createdCount).toBe(CASE_COUNT);

      const addRes = await request.post(`/api/cycles/${cycle.id}/testcases`, { data: { testcaseIds } });
      expect(addRes.ok()).toBeTruthy();
      expect(await addRes.json()).toMatchObject({ requested: CASE_COUNT, added: CASE_COUNT, skipped: 0 });

      // Every linked case must be visible in the run, not just counted by it.
      const executions = await (await request.get(`/api/cycles/${cycle.id}/executions`)).json();
      expect(executions).toHaveLength(CASE_COUNT);
      expect(executions.every((e: { status: string }) => e.status === "Untested")).toBeTruthy();

      // The run card's total is what used to drift from the table above.
      const runs = await (await request.get(`/api/projects/${ctx.projectId}/cycles`)).json();
      const thisRun = runs.find((r: { id: string }) => r.id === cycle.id);
      expect(thisRun.totalCases).toBe(executions.length);
      expect(thisRun.untested).toBe(CASE_COUNT);

      // Re-adding the same selection is a no-op rather than a source of duplicate rows.
      const readdRes = await request.post(`/api/cycles/${cycle.id}/testcases`, { data: { testcaseIds } });
      expect(await readdRes.json()).toMatchObject({ requested: CASE_COUNT, added: 0, skipped: CASE_COUNT });
      expect(await (await request.get(`/api/cycles/${cycle.id}/executions`)).json()).toHaveLength(CASE_COUNT);

      const removeRes = await request.post(`/api/cycles/${cycle.id}/testcases/bulk-delete`, {
        data: { testcaseIds: testcaseIds.slice(0, 250) },
      });
      expect(await removeRes.json()).toMatchObject({ requested: 250, removed: 250 });
      expect(await (await request.get(`/api/cycles/${cycle.id}/executions`)).json()).toHaveLength(CASE_COUNT - 250);
    } finally {
      await request.delete(`/api/cycles/${cycle.id}`, { failOnStatusCode: false });
      if (testcaseIds.length) {
        await request.post(`/api/projects/${ctx.projectId}/testcases/bulk-delete`, {
          data: { testcaseIds },
          failOnStatusCode: false,
        });
      }
    }
  });
});

/*
 * POST /api/cycles/:cycleId/testcases — putting test cases into a run.
 *
 * This endpoint used to loop over the selection, three sequential round trips per case, committing
 * as it went. The UI sends the whole selection in one POST, so a large "select all" ran for minutes
 * and production returned 524 once Cloudflare hit its 100s proxy limit — with whatever had already
 * been written left behind, and a retry duplicating all of it because cycle_items had no unique
 * constraint for the endpoint's `ON CONFLICT DO NOTHING` to fire on.
 *
 * The retry case below is the regression test for that: against the unfixed code it reports two
 * copies of every case. Kept on account A because none of it is destructive — every run and test
 * case is created and torn down inside the test.
 */
test.describe("adding test cases to a run", () => {
  /** A run plus `count` fresh test cases, torn down together. */
  async function seed(
    request: import("@playwright/test").APIRequestContext,
    count: number,
    label: string,
  ): Promise<{ cycleId: string; testcaseIds: string[]; cleanup: () => Promise<void> }> {
    const stamp = `${label} ${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const cycle = await (
      await request.post(`/api/projects/${ctx.projectId}/cycles`, { data: { name: `E2E Run ${stamp}` } })
    ).json();

    /*
     * Serially, on purpose. Creating these with Promise.all put several concurrent creates into the
     * SHARED account-A project, where external ids are allocated as MAX(trailing number)+1 behind a
     * per-project advisory lock with a 5-attempt retry. Five Playwright workers already contend for
     * that project, so a burst from one test exhausted the retry budget; the 23505 then escaped as
     * an unhandled exception, the response was never written, and the caller saw `socket hang up`.
     *
     * Keep the counts here small and let execution-ops.spec.ts carry the large-batch cases, where a
     * disposable tenant allows seeding straight through psql with no id allocation at all.
     */
    const testcaseIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const res = await request.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: `E2E RunCase ${stamp} #${String(i + 1).padStart(3, "0")}` },
      });
      testcaseIds.push((await res.json()).id as string);
    }

    return {
      cycleId: cycle.id,
      testcaseIds,
      cleanup: async () => {
        await request.delete(`/api/cycles/${cycle.id}`, { failOnStatusCode: false });
        await Promise.all(
          testcaseIds.map((id) =>
            request.delete(`/api/projects/${ctx.projectId}/testcases/${id}`, { failOnStatusCode: false }),
          ),
        );
      },
    };
  }

  const executionsOf = async (request: import("@playwright/test").APIRequestContext, cycleId: string) =>
    (await (await request.get(`/api/cycles/${cycleId}/executions`)).json()) as {
      id: string;
      testcaseId: string;
      title: string;
      status: string;
    }[];

  test("adds the whole selection in one call, once each, in the order it was sent", { tag: '@tesbo.testId("TES-TC-906")' }, async ({ request }) => {
    // Five cases, created serially — enough to catch a shuffled or reversed result, cheap enough not
    // to depend on how loaded the shared project is. The same ordering is asserted over 250 cases in
    // execution-ops.spec.ts EXO-E-01, where the fixtures cost nothing.
    const { cycleId, testcaseIds, cleanup } = await seed(request, 5, "Order");
    try {
      const res = await request.post(`/api/cycles/${cycleId}/testcases`, { data: { testcaseIds } });
      expect(res.ok(), `add answered ${res.status()}: ${await res.text()}`).toBeTruthy();

      const executions = await executionsOf(request, cycleId);
      expect(executions).toHaveLength(testcaseIds.length);
      // Order is the assertion that matters here: the rows are now written by a single statement, so
      // they share one created_at and `position` is the only thing left that can carry the caller's
      // ordering. If position were dropped, this comes back shuffled.
      expect(executions.map((e) => e.testcaseId)).toEqual(testcaseIds);
      expect(new Set(executions.map((e) => e.status))).toEqual(new Set(["Untested"]));
    } finally {
      await cleanup();
    }
  });

  test("re-sending the same selection is idempotent — the retry after a timeout must not duplicate", { tag: '@tesbo.testId("TES-TC-907")' }, async ({
    request,
  }) => {
    const { cycleId, testcaseIds, cleanup } = await seed(request, 5, "Retry");
    try {
      await request.post(`/api/cycles/${cycleId}/testcases`, { data: { testcaseIds } });
      const second = await request.post(`/api/cycles/${cycleId}/testcases`, { data: { testcaseIds } });
      expect(second.ok(), `the retry answered ${second.status()}: ${await second.text()}`).toBeTruthy();

      // THE regression assertion. Unfixed, this is 10 — the run holds every case twice, each with
      // its own execution and its own status, which is what users saw after retrying a 524.
      const executions = await executionsOf(request, cycleId);
      expect(executions, "re-adding the same cases duplicated them in the run").toHaveLength(5);
      expect(new Set(executions.map((e) => e.testcaseId))).toEqual(new Set(testcaseIds));
    } finally {
      await cleanup();
    }
  });

  test("the same id repeated inside one request is added once", { tag: '@tesbo.testId("TES-TC-908")' }, async ({ request }) => {
    const { cycleId, testcaseIds, cleanup } = await seed(request, 2, "DupIds");
    try {
      const res = await request.post(`/api/cycles/${cycleId}/testcases`, {
        data: { testcaseIds: [testcaseIds[0], testcaseIds[1], testcaseIds[0], testcaseIds[1]] },
      });
      expect(res.ok()).toBeTruthy();
      expect(await executionsOf(request, cycleId)).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  test("a case removed from a run can be added back", { tag: '@tesbo.testId("TES-TC-909")' }, async ({ request }) => {
    const { cycleId, testcaseIds, cleanup } = await seed(request, 1, "ReAdd");
    try {
      await request.post(`/api/cycles/${cycleId}/testcases`, { data: { testcaseIds } });
      const removed = await request.delete(`/api/cycles/${cycleId}/testcases/${testcaseIds[0]}`, {
        failOnStatusCode: false,
      });
      expect(removed.ok()).toBeTruthy();
      expect(await executionsOf(request, cycleId)).toHaveLength(0);

      // The new unique constraint must not turn "remove then add again" into a permanent refusal.
      const readded = await request.post(`/api/cycles/${cycleId}/testcases`, { data: { testcaseIds } });
      expect(readded.ok(), `re-adding answered ${readded.status()}: ${await readded.text()}`).toBeTruthy();
      expect(await executionsOf(request, cycleId)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  test("adding more cases leaves the statuses already recorded in the run alone", { tag: '@tesbo.testId("TES-TC-910")' }, async ({ request }) => {
    const { cycleId, testcaseIds, cleanup } = await seed(request, 4, "Preserve");
    try {
      await request.post(`/api/cycles/${cycleId}/testcases`, { data: { testcaseIds: testcaseIds.slice(0, 2) } });
      const [first] = await executionsOf(request, cycleId);
      await request.patch(`/api/cycles/${cycleId}/executions/${first.id}`, {
        data: { status: "Passed", actualResult: "verified by the e2e suite" },
      });

      await request.post(`/api/cycles/${cycleId}/testcases`, { data: { testcaseIds } });

      const executions = await executionsOf(request, cycleId);
      expect(executions).toHaveLength(4);
      const passed = executions.find((e) => e.id === first.id);
      expect(passed?.status, "a later add reset an execution that had already been run").toBe("Passed");
    } finally {
      await cleanup();
    }
  });

  test("unknown, malformed and empty selections are refused or skipped, never a 500", { tag: '@tesbo.testId("TES-TC-911")' }, async ({ request }) => {
    const { cycleId, testcaseIds, cleanup } = await seed(request, 1, "BadInput");
    try {
      const cases: { label: string; data: Record<string, unknown> }[] = [
        { label: "empty array", data: { testcaseIds: [] } },
        { label: "missing field", data: {} },
        { label: "null", data: { testcaseIds: null } },
        { label: "unknown uuid", data: { testcaseIds: ["11111111-2222-3333-4444-555555555555"] } },
        // Previously this reached Postgres as `WHERE id = $1` against a uuid column, so a single bad
        // id in a selection failed the entire request with a driver error.
        { label: "malformed id", data: { testcaseIds: ["not-a-uuid"] } },
        { label: "wrong type", data: { testcaseIds: [42] } },
        { label: "mixed good and bad", data: { testcaseIds: [testcaseIds[0], "not-a-uuid"] } },
      ];

      for (const { label, data } of cases) {
        const res = await request.post(`/api/cycles/${cycleId}/testcases`, { data, failOnStatusCode: false });
        expect(res.status(), `${label} answered ${res.status()}: ${await res.text()}`).toBeLessThan(500);
      }

      // Only the one real id in "mixed good and bad" should have landed.
      const executions = await executionsOf(request, cycleId);
      expect(executions.map((e) => e.testcaseId)).toEqual([testcaseIds[0]]);
    } finally {
      await cleanup();
    }
  });

  test("the singular testcaseId body form still works", { tag: '@tesbo.testId("TES-TC-912")' }, async ({ request }) => {
    const { cycleId, testcaseIds, cleanup } = await seed(request, 1, "Singular");
    try {
      const res = await request.post(`/api/cycles/${cycleId}/testcases`, {
        data: { testcaseId: testcaseIds[0] },
      });
      expect(res.ok(), `singular form answered ${res.status()}: ${await res.text()}`).toBeTruthy();
      expect(await executionsOf(request, cycleId)).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  test("a test case from another project in the same workspace is not adopted", { tag: '@tesbo.testId("TES-TC-913")' }, async ({ request }) => {
    const other = await (
      await request.post("/api/projects", { data: { name: `E2E Other Project ${Date.now()}` } })
    ).json();
    const { cycleId, cleanup } = await seed(request, 0, "CrossProject");
    let foreignCaseId: string | null = null;
    try {
      foreignCaseId = (
        await (
          await request.post(`/api/projects/${other.id}/testcases`, {
            data: { title: `E2E Foreign Case ${Date.now()}` },
          })
        ).json()
      ).id;

      const res = await request.post(`/api/cycles/${cycleId}/testcases`, {
        data: { testcaseIds: [foreignCaseId] },
        failOnStatusCode: false,
      });
      expect(res.status(), `answered ${res.status()}: ${await res.text()}`).toBeLessThan(500);

      // The run belongs to ctx.projectId; a case from a different project must not end up in it,
      // snapshot_title and all.
      expect(await executionsOf(request, cycleId)).toHaveLength(0);
    } finally {
      await cleanup();
      await request.delete(`/api/projects/${other.id}`, { failOnStatusCode: false });
    }
  });

  test("an anonymous caller cannot add cases to a run", { tag: '@tesbo.testId("TES-TC-914")' }, async ({ playwright }) => {
    const anon = await playwright.request.newContext({ baseURL: env.apiBaseUrl, storageState: undefined });
    try {
      const res = await anon.post(`/api/cycles/${ctx.projectId}/testcases`, {
        data: { testcaseIds: [] },
        failOnStatusCode: false,
      });
      expect([400, 401, 403, 404], `anonymous add answered ${res.status()}`).toContain(res.status());
    } finally {
      await anon.dispose();
    }
  });
});

/*
 * Run start and end timestamps — Basecamp 10221952787 ("[Test Run] history not showing when test
 * was run").
 *
 * `cycles.started_at` and `cycles.ended_at` existed from the first migration and were written by
 * nothing: only read. The runs list renders a clock from formatDuration(startedAt, endedAt), so it
 * showed "—" for every run in the product, completed ones included. The status transition stamps
 * them now, which is what the Start and Mark Completed buttons drive.
 */
test.describe("run timing", () => {
  async function createRun(request: any, name: string) {
    return (await request.post(`/api/projects/${ctx.projectId}/cycles`, { data: { name } })).json();
  }

  async function readRun(request: any, id: string) {
    return (await request.get(`/api/cycles/${id}`)).json();
  }

  test("starting a run stamps startedAt, completing it stamps endedAt", { tag: '@tesbo.testId("TES-TC-1163")' }, async ({ request }) => {
    const run = await createRun(request, `E2E Run Timing ${Date.now()}`);
    try {
      // A run is created in Planning and has not started.
      expect(run.startedAt ?? null).toBeNull();
      expect(run.endedAt ?? null).toBeNull();

      await request.patch(`/api/cycles/${run.id}`, { data: { status: "In Progress" } });
      const started = await readRun(request, run.id);
      expect(started.startedAt, "a run that is In Progress has to know when it started").toBeTruthy();
      expect(started.endedAt ?? null).toBeNull();

      await request.patch(`/api/cycles/${run.id}`, { data: { status: "Completed" } });
      const completed = await readRun(request, run.id);
      expect(completed.endedAt).toBeTruthy();
      // The original start survives completion — otherwise the duration is always zero.
      expect(completed.startedAt).toBe(started.startedAt);
      expect(new Date(completed.endedAt).getTime()).toBeGreaterThanOrEqual(new Date(completed.startedAt).getTime());
    } finally {
      await request.delete(`/api/cycles/${run.id}`, { failOnStatusCode: false });
    }
  });

  test("reopening a completed run clears its end, and an unrelated edit leaves the clock alone", { tag: '@tesbo.testId("TES-TC-1164")' }, async ({
    request,
  }) => {
    const run = await createRun(request, `E2E Run Reopen ${Date.now()}`);
    try {
      await request.patch(`/api/cycles/${run.id}`, { data: { status: "In Progress" } });
      await request.patch(`/api/cycles/${run.id}`, { data: { status: "Completed" } });
      const completed = await readRun(request, run.id);
      expect(completed.endedAt).toBeTruthy();

      // Reopened: it is running again, so it has no end.
      await request.patch(`/api/cycles/${run.id}`, { data: { status: "In Progress" } });
      const reopened = await readRun(request, run.id);
      expect(reopened.endedAt ?? null).toBeNull();
      expect(reopened.startedAt).toBe(completed.startedAt);

      // Renaming a run is not a transition and must not touch either timestamp.
      await request.patch(`/api/cycles/${run.id}`, { data: { name: `${run.name} renamed` } });
      const renamed = await readRun(request, run.id);
      expect(renamed.startedAt).toBe(reopened.startedAt);
      expect(renamed.endedAt ?? null).toBeNull();
    } finally {
      await request.delete(`/api/cycles/${run.id}`, { failOnStatusCode: false });
    }
  });

  test("a run taken straight to Completed still gets a start to measure from", { tag: '@tesbo.testId("TES-TC-1165")' }, async ({ request }) => {
    // The transition Planning -> Completed skips In Progress entirely; without the back-fill the
    // duration would be computed from a null start and read "—" forever.
    const run = await createRun(request, `E2E Run Straight Complete ${Date.now()}`);
    try {
      await request.patch(`/api/cycles/${run.id}`, { data: { status: "Completed" } });
      const completed = await readRun(request, run.id);
      expect(completed.startedAt).toBeTruthy();
      expect(completed.endedAt).toBeTruthy();
    } finally {
      await request.delete(`/api/cycles/${run.id}`, { failOnStatusCode: false });
    }
  });
});

test.describe("list-cycles bucket counts", () => {
  // Regression for the Test Runs Pass Rate mismatch: the frontend's summary tile and the run
  // details page each compute their own pass rate from these bucket fields, and both now assume
  // passed + failed + blocked + skipped + untested === totalCases for every status a case can be
  // in. If a new status is ever added to EXECUTION_STATUSES without a matching bucket, this drifts
  // silently and the two pages diverge again exactly as they did before the fix.
  test("passed, failed, blocked, skipped and untested buckets always sum to totalCases", { tag: '@tesbo.testId("TES-TC-1166")' }, async ({ request }) => {
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const cycle = await (
      await request.post(`/api/projects/${ctx.projectId}/cycles`, { data: { name: `E2E Bucket Sum ${stamp}` } })
    ).json();

    const statuses = ["Passed", "Failed", "Blocked", "Skipped", "Retest", "Untested"];
    const created = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases/bulk-create`, {
        data: { testcases: statuses.map((_, i) => ({ title: `E2E Bucket Sum Case ${stamp}-${i}`, status: "Approved" })) },
      })
    ).json();
    const testcaseIds: string[] = created.created.map((c: { id: string }) => c.id);

    try {
      await request.post(`/api/cycles/${cycle.id}/testcases`, { data: { testcaseIds } });
      const executions = await (await request.get(`/api/cycles/${cycle.id}/executions`)).json();
      for (let i = 0; i < statuses.length; i++) {
        if (statuses[i] === "Untested") continue;
        await request.patch(`/api/cycles/${cycle.id}/executions/${executions[i].id}`, { data: { status: statuses[i] } });
      }

      const runs = await (await request.get(`/api/projects/${ctx.projectId}/cycles`)).json();
      const thisRun = runs.find((r: { id: string }) => r.id === cycle.id);
      expect(thisRun.totalCases).toBe(statuses.length);
      // Retest has no dedicated bucket of its own and is folded into "untested" alongside the
      // literal Untested case, so untested is 2 (Retest + Untested) here, not 1.
      expect(thisRun.passed + thisRun.failed + thisRun.blocked + thisRun.skipped + thisRun.untested).toBe(
        thisRun.totalCases,
      );
      expect(thisRun.untested).toBe(2);
    } finally {
      await request.delete(`/api/cycles/${cycle.id}`, { failOnStatusCode: false });
      await request.post(`/api/projects/${ctx.projectId}/testcases/bulk-delete`, {
        data: { testcaseIds },
        failOnStatusCode: false,
      });
    }
  });
});
