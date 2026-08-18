import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { env } from "../utils/env";

const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));

test.describe("test cycle / run CRUD", () => {
  test("supports the create -> read -> update -> list -> delete lifecycle", async ({ request }) => {
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

  test("updateCycle's planId/clearPlan semantics: an omitted planId keeps it, clearPlan:true nulls it", async ({
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

  test("supports adding and removing test cases, auto-creating one execution per added case", async ({
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

  test("from-plan and from-cases creation are aliases for plain create — neither seeds cycle_items", async ({
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

  test("adds the whole selection in one call, once each, in the order it was sent", async ({ request }) => {
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

  test("re-sending the same selection is idempotent — the retry after a timeout must not duplicate", async ({
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

  test("the same id repeated inside one request is added once", async ({ request }) => {
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

  test("a case removed from a run can be added back", async ({ request }) => {
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

  test("adding more cases leaves the statuses already recorded in the run alone", async ({ request }) => {
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

  test("unknown, malformed and empty selections are refused or skipped, never a 500", async ({ request }) => {
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

  test("the singular testcaseId body form still works", async ({ request }) => {
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

  test("a test case from another project in the same workspace is not adopted", async ({ request }) => {
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

  test("an anonymous caller cannot add cases to a run", async ({ playwright }) => {
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
