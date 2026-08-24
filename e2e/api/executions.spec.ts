import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));

async function makeExecutionFixture(request: import("@playwright/test").APIRequestContext) {
  const cycle = await (
    await request.post(`/api/projects/${ctx.projectId}/cycles`, {
      data: { name: `E2E Execution Cycle ${Date.now()}` },
    })
  ).json();
  const testcase = await (
    await request.post(`/api/projects/${ctx.projectId}/testcases`, {
      data: { title: `E2E Execution Test Case ${Date.now()}` },
    })
  ).json();
  await request.post(`/api/cycles/${cycle.id}/testcases`, { data: { testcaseIds: [testcase.id] } });
  const executions = await (await request.get(`/api/cycles/${cycle.id}/executions`)).json();
  return { cycle, testcase, execution: executions[0] };
}

async function cleanupExecutionFixture(
  request: import("@playwright/test").APIRequestContext,
  fixture: { cycle: { id: string }; testcase: { id: string } },
) {
  await request.delete(`/api/cycles/${fixture.cycle.id}`, { failOnStatusCode: false });
  await request.delete(`/api/projects/${ctx.projectId}/testcases/${fixture.testcase.id}`, {
    failOnStatusCode: false,
  });
}

test.describe("test execution updates", () => {
  test("adding a test case to a cycle auto-creates an Untested execution with no executedAt", async ({
    request,
  }) => {
    const fixture = await makeExecutionFixture(request);
    try {
      expect(fixture.execution.status).toBe("Untested");
      expect(fixture.execution.executedAt).toBeFalsy();
      expect(fixture.execution.testcaseId).toBe(fixture.testcase.id);
    } finally {
      await cleanupExecutionFixture(request, fixture);
    }
  });

  test("updating status stamps executedAt; updating an unrelated field without status does not", async ({
    request,
  }) => {
    const fixture = await makeExecutionFixture(request);
    try {
      const passRes = await request.patch(
        `/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`,
        { data: { status: "Passed" } },
      );
      expect(passRes.ok()).toBeTruthy();

      const afterPass = await (await request.get(`/api/cycles/${fixture.cycle.id}/executions`)).json();
      const passedExecution = afterPass[0];
      expect(passedExecution.status).toBe("Passed");
      expect(passedExecution.executedAt).toBeTruthy();
      const stampedAt = passedExecution.executedAt;

      // Sending actualResult with no status must leave the existing executedAt stamp untouched
      // (legacy.service.ts:1822's `CASE WHEN $2 IS NULL THEN executed_at ELSE now() END`).
      await request.patch(`/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`, {
        data: { actualResult: "Observed behavior differs from expected" },
      });

      const afterUnrelatedUpdate = await (
        await request.get(`/api/cycles/${fixture.cycle.id}/executions`)
      ).json();
      const updatedExecution = afterUnrelatedUpdate[0];
      expect(updatedExecution.actualResult).toBe("Observed behavior differs from expected");
      expect(updatedExecution.status).toBe("Passed");
      expect(updatedExecution.executedAt).toBe(stampedAt);
    } finally {
      await cleanupExecutionFixture(request, fixture);
    }
  });

  test("persists assigneeId, defectKey, and defectUrl", async ({ request }) => {
    const fixture = await makeExecutionFixture(request);
    try {
      const meRes = await request.get("/api/auth/me");
      const me = await meRes.json();

      const patchRes = await request.patch(
        `/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`,
        {
          data: {
            status: "Failed",
            assigneeId: me.userId,
            defectKey: "BUG-123",
            defectUrl: "https://example.com/BUG-123",
          },
        },
      );
      expect(patchRes.ok()).toBeTruthy();

      const afterUpdate = await (await request.get(`/api/cycles/${fixture.cycle.id}/executions`)).json();
      const updatedExecution = afterUpdate[0];
      expect(updatedExecution.assigneeId).toBe(me.userId);
      expect(updatedExecution.defectKey).toBe("BUG-123");
      expect(updatedExecution.defectUrl).toBe("https://example.com/BUG-123");
    } finally {
      await cleanupExecutionFixture(request, fixture);
    }
  });

  test("supports every status in the EXEC_STATUSES set the UI offers", async ({ request }) => {
    const fixture = await makeExecutionFixture(request);
    try {
      for (const status of ["Untested", "Passed", "Failed", "Skipped", "Blocked", "Retest"]) {
        const patchRes = await request.patch(
          `/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`,
          { data: { status } },
        );
        expect(patchRes.ok()).toBeTruthy();

        const afterUpdate = await (await request.get(`/api/cycles/${fixture.cycle.id}/executions`)).json();
        expect(afterUpdate[0].status).toBe(status);
      }
    } finally {
      await cleanupExecutionFixture(request, fixture);
    }
  });
});

/*
 * Defect references belong to failures — Basecamp 10221790207 ("Only failed test case should show
 * defect key and Defect URL").
 *
 * The two fields were offered on every status, so a case could pass while still carrying a defect
 * key. That value is not cosmetic: it travels into the run's CSV export and the traceability matrix,
 * where it reads as a bug against a case that passed. The screens hide the inputs unless the status
 * is Failed, and the service clears the stored values when any other status is recorded — hiding
 * alone would have left the stale reference in the database and in every export that reads it.
 */
test.describe("defect fields follow the result", () => {
  test("a defect recorded on a failure is kept while it is still failing", async ({ request }) => {
    const fixture = await makeExecutionFixture(request);
    try {
      await request.patch(`/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`, {
        data: { status: "Failed", defectKey: "PROJ-123", defectUrl: "https://tracker.example/PROJ-123" },
      });
      const [failed] = await (await request.get(`/api/cycles/${fixture.cycle.id}/executions`)).json();
      expect(failed.status).toBe("Failed");
      expect(failed.defectKey).toBe("PROJ-123");
      expect(failed.defectUrl).toBe("https://tracker.example/PROJ-123");

      // Editing the failure without resending them leaves them alone.
      await request.patch(`/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`, {
        data: { status: "Failed", actualResult: "still broken" },
      });
      const [stillFailed] = await (await request.get(`/api/cycles/${fixture.cycle.id}/executions`)).json();
      expect(stillFailed.defectKey).toBe("PROJ-123");
    } finally {
      await cleanupExecutionFixture(request, fixture);
    }
  });

  test("passing the case afterwards clears the defect it used to carry", async ({ request }) => {
    const fixture = await makeExecutionFixture(request);
    try {
      await request.patch(`/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`, {
        data: { status: "Failed", defectKey: "PROJ-456", defectUrl: "https://tracker.example/PROJ-456" },
      });
      await request.patch(`/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`, {
        data: { status: "Passed" },
      });

      const [passed] = await (await request.get(`/api/cycles/${fixture.cycle.id}/executions`)).json();
      expect(passed.status).toBe("Passed");
      expect(passed.defectKey ?? null, "a passing case must not still point at a defect").toBeNull();
      expect(passed.defectUrl ?? null).toBeNull();
    } finally {
      await cleanupExecutionFixture(request, fixture);
    }
  });

  test("the same clearing applies to blocked and skipped, and the export follows", async ({ request }) => {
    const fixture = await makeExecutionFixture(request);
    try {
      for (const status of ["Blocked", "Skipped", "Retest", "Untested"]) {
        await request.patch(`/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`, {
          data: { status: "Failed", defectKey: "PROJ-789" },
        });
        await request.patch(`/api/cycles/${fixture.cycle.id}/executions/${fixture.execution.id}`, {
          data: { status },
        });
        const [row] = await (await request.get(`/api/cycles/${fixture.cycle.id}/executions`)).json();
        expect(row.status).toBe(status);
        expect(row.defectKey ?? null, `${status} should not keep a defect key`).toBeNull();
      }

      // The export reads the same column, which is where a stale key did the real damage.
      const csv = await (await request.get(`/api/cycles/${fixture.cycle.id}/export/csv`)).text();
      expect(csv).not.toContain("PROJ-789");
    } finally {
      await cleanupExecutionFixture(request, fixture);
    }
  });
});
