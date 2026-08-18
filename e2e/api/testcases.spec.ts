import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));

async function createCase(request: import("@playwright/test").APIRequestContext, data: Record<string, unknown> = {}) {
  const res = await request.post(`/api/projects/${ctx.projectId}/testcases`, {
    data: { title: `E2E ${Date.now()}`, ...data },
  });
  return res.json();
}

async function deleteCase(request: import("@playwright/test").APIRequestContext, id: string) {
  await request.delete(`/api/projects/${ctx.projectId}/testcases/${id}`, { failOnStatusCode: false });
}

async function createSuite(request: import("@playwright/test").APIRequestContext, name: string) {
  return (await request.post(`/api/projects/${ctx.projectId}/suites`, { data: { name } })).json();
}

async function deleteSuite(request: import("@playwright/test").APIRequestContext, id: string) {
  await request.delete(`/api/suites/${id}`, { failOnStatusCode: false });
}

test.describe("test case CRUD", () => {
  test("supports the create -> read -> update -> list -> delete lifecycle", async ({ request }) => {
    const title = `E2E smoke test case ${Date.now()}`;

    const createRes = await request.post(`/api/projects/${ctx.projectId}/testcases`, {
      data: { title },
    });
    expect(createRes.ok()).toBeTruthy();
    const created = await createRes.json();
    expect(created.id).toBeTruthy();
    const testcaseId = created.id;

    const getRes = await request.get(`/api/projects/${ctx.projectId}/testcases/${testcaseId}`);
    expect(getRes.ok()).toBeTruthy();
    expect((await getRes.json()).title).toBe(title);

    const updatedTitle = `${title} (updated)`;
    const putRes = await request.put(`/api/projects/${ctx.projectId}/testcases/${testcaseId}`, {
      data: { title: updatedTitle },
    });
    expect(putRes.ok()).toBeTruthy();

    const getAfterUpdateRes = await request.get(
      `/api/projects/${ctx.projectId}/testcases/${testcaseId}`,
    );
    expect((await getAfterUpdateRes.json()).title).toBe(updatedTitle);

    const listRes = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
      params: { search: updatedTitle },
    });
    expect(listRes.ok()).toBeTruthy();
    const list = await listRes.json();
    expect(list.some((tc: { id: string }) => tc.id === testcaseId)).toBeTruthy();

    const deleteRes = await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcaseId}`);
    expect(deleteRes.ok()).toBeTruthy();

    const getAfterDeleteRes = await request.get(
      `/api/projects/${ctx.projectId}/testcases/${testcaseId}`,
    );
    expect(getAfterDeleteRes.status()).toBe(404);
  });

  test("defaults are applied when optional fields are omitted on create", async ({ request }) => {
    const created = await createCase(request);
    try {
      expect(created.priority).toBe("P2");
      expect(created.type).toBe("Functional");
      expect(created.status).toBe("Draft");
      expect(created.automationStatus).toBe("Not Automated");
      expect(created.suiteId).toBeNull();
      expect(created.steps).toEqual([]);
      expect(created.externalId).toBeTruthy();
    } finally {
      await deleteCase(request, created.id);
    }
  });

  test("blank title defaults to 'Untitled test case' when omitted entirely, but an explicit empty string is honored", async ({
    request,
  }) => {
    const withoutTitle = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, { data: {} })
    ).json();
    const withBlankTitle = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title: "" } })
    ).json();

    try {
      expect(withoutTitle.title).toBe("Untitled test case");
      // KNOWN GAP: createTestCase uses `body.title || "Untitled test case"` (falsy-check), so an
      // explicit "" also falls back to the default here — unlike updateTestCase's `??` pattern
      // below, which lets "" through as a real (blank) value once the row already exists.
      expect(withBlankTitle.title).toBe("Untitled test case");
    } finally {
      await deleteCase(request, withoutTitle.id);
      await deleteCase(request, withBlankTitle.id);
    }
  });

  test("an explicit empty string clears text fields on update ('?? null' treats '' as provided, unlike bugs' '|| null' pattern)", async ({
    request,
  }) => {
    const created = await createCase(request, {
      description: "Original description",
      testData: "Original test data",
    });

    try {
      const res = await request.put(`/api/projects/${ctx.projectId}/testcases/${created.id}`, {
        data: { title: "", description: "", testData: "" },
      });
      expect(res.ok()).toBeTruthy();

      const after = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases/${created.id}`)
      ).json();
      expect(after.title).toBe("");
      expect(after.description).toBe("");
      expect(after.testData).toBe("");
    } finally {
      await deleteCase(request, created.id);
    }
  });

  test("estimatedDuration is accepted on create/update but silently discarded (dead field)", async ({
    request,
  }) => {
    // KNOWN GAP: the `estimated_duration` column exists (migrations/V7_testcase_additional_fields.sql)
    // and the manual test-case form / import mapping UI both expose it, but createTestCase and
    // updateTestCase never reference it in their INSERT/UPDATE column lists — anything sent here
    // is silently dropped rather than persisted or rejected. Pinned per
    // FEATURE_DOCUMENTATION.md Appendix C4.
    const created = await createCase(request, { estimatedDuration: 45 });
    try {
      expect(created.estimatedDuration).toBeNull();

      await request.put(`/api/projects/${ctx.projectId}/testcases/${created.id}`, {
        data: { estimatedDuration: 90 },
      });
      const after = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases/${created.id}`)
      ).json();
      expect(after.estimatedDuration).toBeNull();
    } finally {
      await deleteCase(request, created.id);
    }
  });

  test("getting, updating, or deleting a nonexistent test case returns 404", async ({ request }) => {
    const missingId = "00000000-0000-0000-0000-000000000000";

    const getRes = await request.get(`/api/projects/${ctx.projectId}/testcases/${missingId}`, {
      failOnStatusCode: false,
    });
    expect(getRes.status()).toBe(404);

    const putRes = await request.put(`/api/projects/${ctx.projectId}/testcases/${missingId}`, {
      data: { title: "nope" },
      failOnStatusCode: false,
    });
    expect(putRes.status()).toBe(404);

    const deleteRes = await request.delete(`/api/projects/${ctx.projectId}/testcases/${missingId}`, {
      failOnStatusCode: false,
    });
    expect(deleteRes.status()).toBe(404);
  });

  test("delete is a soft delete — the row disappears from get/list but the external_id isn't recyclable", async ({
    request,
  }) => {
    const created = await createCase(request);
    const externalId = created.externalId;
    await request.delete(`/api/projects/${ctx.projectId}/testcases/${created.id}`);

    const getAfterDelete = await request.get(
      `/api/projects/${ctx.projectId}/testcases/${created.id}`,
      { failOnStatusCode: false },
    );
    expect(getAfterDelete.status()).toBe(404);

    // (project_id, external_id) is UNIQUE at the DB level with no partial/deleted_at-aware index,
    // so a soft-deleted case's external_id is gone forever — re-creating with the same explicit
    // externalId must fail even though the case is invisible everywhere else.
    const collideRes = await request.post(`/api/projects/${ctx.projectId}/testcases`, {
      data: { title: "Collides with a deleted case's external id", externalId },
      failOnStatusCode: false,
    });
    expect(collideRes.ok()).toBeFalsy();
  });
});

test.describe("move to suite", () => {
  test("creating a test case with a suiteId assigns it to that suite", async ({ request }) => {
    const suite = await createSuite(request, `E2E Move Create Suite ${Date.now()}`);
    const created = await createCase(request, { suiteId: suite.id });

    try {
      expect(created.suiteId).toBe(suite.id);
    } finally {
      await deleteCase(request, created.id);
      await deleteSuite(request, suite.id);
    }
  });

  test("updating suiteId moves a test case from one suite to another", async ({ request }) => {
    const suiteA = await createSuite(request, `E2E Move A ${Date.now()}`);
    const suiteB = await createSuite(request, `E2E Move B ${Date.now()}`);
    const created = await createCase(request, { suiteId: suiteA.id });

    try {
      const moveRes = await request.put(`/api/projects/${ctx.projectId}/testcases/${created.id}`, {
        data: { suiteId: suiteB.id },
      });
      expect(moveRes.ok()).toBeTruthy();

      const after = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases/${created.id}`)
      ).json();
      expect(after.suiteId).toBe(suiteB.id);
    } finally {
      await deleteCase(request, created.id);
      await deleteSuite(request, suiteA.id);
      await deleteSuite(request, suiteB.id);
    }
  });

  test("moving back to no suite by sending suiteId: null un-suites the test case", async ({ request }) => {
    const suite = await createSuite(request, `E2E Move To Null ${Date.now()}`);
    const created = await createCase(request, { suiteId: suite.id });

    try {
      await request.put(`/api/projects/${ctx.projectId}/testcases/${created.id}`, {
        data: { suiteId: null },
      });
      const after = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases/${created.id}`)
      ).json();
      expect(after.suiteId).toBeNull();
    } finally {
      await deleteCase(request, created.id);
      await deleteSuite(request, suite.id);
    }
  });

  test("omitting suiteId on update un-assigns the suite (suite_id is overwritten, not COALESCEd)", async ({
    request,
  }) => {
    // KNOWN GAP (documented, not test.fail() — mirrors updateSuite's parentId bug in
    // suites.spec.ts): unlike every other column in updateTestCase, `suite_id=$2` is bound
    // directly to `body.suiteId ?? null` instead of COALESCE(...) — so any update that doesn't
    // explicitly resend the current suiteId silently un-suites the test case.
    const suite = await createSuite(request, `E2E Move Unassign ${Date.now()}`);
    const created = await createCase(request, { suiteId: suite.id });

    try {
      await request.put(`/api/projects/${ctx.projectId}/testcases/${created.id}`, {
        data: { description: "unrelated update, no suiteId sent" },
      });

      const after = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases/${created.id}`)
      ).json();
      expect(after.suiteId).toBeNull();
    } finally {
      await deleteCase(request, created.id);
      await deleteSuite(request, suite.id);
    }
  });

  test("bulk-update moves many test cases into a suite in one call", async ({ request }) => {
    const suite = await createSuite(request, `E2E Bulk Move Suite ${Date.now()}`);
    const a = await createCase(request);
    const b = await createCase(request);

    try {
      const res = await request.post(`/api/projects/${ctx.projectId}/testcases/bulk-update`, {
        data: { testcaseIds: [a.id, b.id], suiteId: suite.id },
      });
      expect(res.ok()).toBeTruthy();

      for (const id of [a.id, b.id]) {
        const after = await (await request.get(`/api/projects/${ctx.projectId}/testcases/${id}`)).json();
        expect(after.suiteId).toBe(suite.id);
      }
    } finally {
      await deleteCase(request, a.id);
      await deleteCase(request, b.id);
      await deleteSuite(request, suite.id);
    }
  });
});

test.describe("field edits — every editable field", () => {
  test("create accepts the full field set and returns each field verbatim", async ({ request }) => {
    const suite = await createSuite(request, `E2E Full Fields Suite ${Date.now()}`);
    const me = await (await request.get("/api/auth/me")).json();
    const steps = [
      { stepNumber: 1, action: "Open the login page", expectedResult: "Login form is visible" },
      { stepNumber: 2, action: "Submit valid credentials", expectedResult: "User lands on the dashboard" },
    ];

    const payload = {
      suiteId: suite.id,
      title: `E2E Full Fields ${Date.now()}`,
      description: "Full description",
      preconditions: "User has an account",
      postconditions: "User is logged in",
      steps,
      testData: "user@example.com / Passw0rd!",
      priority: "P1",
      severity: "High",
      type: "Regression",
      automationStatus: "Automated",
      automationRepo: "github.com/org/repo",
      automationPath: "tests/login.spec.ts",
      automationTestName: "logs in with valid credentials",
      automationFramework: "Playwright",
      automationTags: "smoke,auth",
      ownerId: me.userId,
      component: "Auth",
      status: "In Review",
      jiraIssueKey: "PROJ-123",
      jiraUrl: "https://example.atlassian.net/browse/PROJ-123",
      linearIssueKey: "ENG-45",
      linearUrl: "https://linear.app/team/issue/ENG-45",
      attachments: "See PROJ-123 for context",
    };

    const created = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, { data: payload })
    ).json();

    try {
      for (const [key, value] of Object.entries(payload)) {
        if (key === "steps") expect(created.steps).toEqual(steps);
        else expect(created[key as keyof typeof created]).toBe(value);
      }
    } finally {
      await deleteCase(request, created.id);
      await deleteSuite(request, suite.id);
    }
  });

  test("update can change every editable field to a new value", async ({ request }) => {
    const suiteA = await createSuite(request, `E2E Edit A ${Date.now()}`);
    const suiteB = await createSuite(request, `E2E Edit B ${Date.now()}`);
    const owner = await (await request.get("/api/auth/me")).json();
    const original = await createCase(request, { suiteId: suiteA.id });
    const updatedSteps = [{ stepNumber: 1, action: "Updated action", expectedResult: "Updated result" }];

    const updates = {
      suiteId: suiteB.id,
      title: `E2E Edit Updated ${Date.now()}`,
      description: "Updated description",
      preconditions: "Updated preconditions",
      postconditions: "Updated postconditions",
      steps: updatedSteps,
      testData: "updated test data",
      priority: "P0",
      severity: "Critical",
      type: "Security",
      automationStatus: "Not Automated",
      automationRepo: "github.com/org/updated-repo",
      automationPath: "tests/updated.spec.ts",
      automationTestName: "updated test name",
      automationFramework: "Cypress",
      automationTags: "regression,security",
      ownerId: owner.userId,
      component: "Updated component",
      status: "Deprecated",
      jiraIssueKey: "PROJ-999",
      jiraUrl: "https://example.atlassian.net/browse/PROJ-999",
      linearIssueKey: "ENG-99",
      linearUrl: "https://linear.app/team/issue/ENG-99",
      attachments: "Updated notes",
    };

    try {
      const res = await request.put(`/api/projects/${ctx.projectId}/testcases/${original.id}`, {
        data: updates,
      });
      expect(res.ok()).toBeTruthy();

      const after = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases/${original.id}`)
      ).json();
      for (const [key, value] of Object.entries(updates)) {
        if (key === "steps") expect(after.steps).toEqual(updatedSteps);
        else expect(after[key as keyof typeof after]).toBe(value);
      }
    } finally {
      await deleteCase(request, original.id);
      await deleteSuite(request, suiteA.id);
      await deleteSuite(request, suiteB.id);
    }
  });
});

test.describe("bulk operations", () => {
  test("bulk-update changes priority, status and ownerId for every selected test case", async ({ request }) => {
    const me = await (await request.get("/api/auth/me")).json();
    const a = await createCase(request, { priority: "P3", status: "Draft" });
    const b = await createCase(request, { priority: "P3", status: "Draft" });

    try {
      const res = await request.post(`/api/projects/${ctx.projectId}/testcases/bulk-update`, {
        data: { testcaseIds: [a.id, b.id], priority: "P0", status: "Approved", ownerId: me.userId },
      });
      expect(res.ok()).toBeTruthy();

      for (const id of [a.id, b.id]) {
        const after = await (await request.get(`/api/projects/${ctx.projectId}/testcases/${id}`)).json();
        expect(after.priority).toBe("P0");
        expect(after.status).toBe("Approved");
        expect(after.ownerId).toBe(me.userId);
      }
    } finally {
      await deleteCase(request, a.id);
      await deleteCase(request, b.id);
    }
  });

  test("bulk-update sending an empty string leaves that field unchanged (falsy-check, unlike single-update's blank-out gap)", async ({
    request,
  }) => {
    const created = await createCase(request, { priority: "P1" });

    try {
      await request.post(`/api/projects/${ctx.projectId}/testcases/bulk-update`, {
        data: { testcaseIds: [created.id], priority: "" },
      });
      const after = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases/${created.id}`)
      ).json();
      expect(after.priority).toBe("P1");
    } finally {
      await deleteCase(request, created.id);
    }
  });

  test("bulk-update no-ops silently on an empty testcaseIds array", async ({ request }) => {
    const res = await request.post(`/api/projects/${ctx.projectId}/testcases/bulk-update`, {
      data: { testcaseIds: [], priority: "P0" },
    });
    expect(res.ok()).toBeTruthy();
  });

  test("bulk-delete soft-deletes every selected test case", async ({ request }) => {
    const a = await createCase(request);
    const b = await createCase(request);

    const res = await request.post(`/api/projects/${ctx.projectId}/testcases/bulk-delete`, {
      data: { testcaseIds: [a.id, b.id] },
    });
    expect(res.ok()).toBeTruthy();

    for (const id of [a.id, b.id]) {
      const getRes = await request.get(`/api/projects/${ctx.projectId}/testcases/${id}`, {
        failOnStatusCode: false,
      });
      expect(getRes.status()).toBe(404);
    }
  });

  test("bulk-delete no-ops silently on an empty testcaseIds array", async ({ request }) => {
    const res = await request.post(`/api/projects/${ctx.projectId}/testcases/bulk-delete`, {
      data: { testcaseIds: [] },
    });
    expect(res.ok()).toBeTruthy();
  });

  test("archiving sets status to Archived; restoring a prior status is just another update", async ({
    request,
  }) => {
    const created = await createCase(request, { status: "Approved" });

    try {
      await request.put(`/api/projects/${ctx.projectId}/testcases/${created.id}`, {
        data: { status: "Archived" },
      });
      const archived = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases/${created.id}`)
      ).json();
      expect(archived.status).toBe("Archived");

      // The frontend's "Unarchive" button always sends status:"Draft" regardless of what the
      // status was before archiving, rather than restoring "Approved" (see
      // FEATURE_DOCUMENTATION.md Section B5) — a UI-level gap, not a backend one. The backend
      // itself has no opinion on the prior value and accepts whatever status a direct PUT sends,
      // which is what this asserts.
      await request.put(`/api/projects/${ctx.projectId}/testcases/${created.id}`, {
        data: { status: "Approved" },
      });
      const restored = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases/${created.id}`)
      ).json();
      expect(restored.status).toBe("Approved");
    } finally {
      await deleteCase(request, created.id);
    }
  });
});

test.describe("search", () => {
  test("matches by title substring, case-insensitively", async ({ request }) => {
    const marker = `E2E Search Title ${Date.now()}`;
    const created = await createCase(request, { title: marker });

    try {
      const res = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, {
          params: { search: marker.toUpperCase() },
        })
      ).json();
      expect(res.some((tc: { id: string }) => tc.id === created.id)).toBeTruthy();
    } finally {
      await deleteCase(request, created.id);
    }
  });

  test("matches by external ID substring", async ({ request }) => {
    const created = await createCase(request);

    try {
      const idFragment = created.externalId.slice(-4);
      const res = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, { params: { search: idFragment } })
      ).json();
      expect(res.some((tc: { id: string }) => tc.id === created.id)).toBeTruthy();
    } finally {
      await deleteCase(request, created.id);
    }
  });

  test("matches by type substring, excluding other types", async ({ request }) => {
    const marker = Date.now();
    const regression = await createCase(request, { title: `E2E Search Type A ${marker}`, type: "Regression" });
    const smoke = await createCase(request, { title: `E2E Search Type B ${marker}`, type: "Smoke" });

    try {
      const res = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, { params: { search: "regression" } })
      ).json();
      expect(res.some((tc: { id: string }) => tc.id === regression.id)).toBeTruthy();
      expect(res.some((tc: { id: string }) => tc.id === smoke.id)).toBeFalsy();
    } finally {
      await deleteCase(request, regression.id);
      await deleteCase(request, smoke.id);
    }
  });

  test("returns an empty list when nothing matches", async ({ request }) => {
    const res = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
      params: { search: `no-such-testcase-${Date.now()}` },
    });
    expect(res.ok()).toBeTruthy();
    expect(await res.json()).toEqual([]);
  });

  test("an unescaped LIKE wildcard in the search term over-matches instead of being treated literally", async ({
    request,
  }) => {
    // KNOWN GAP: listTestCases() wraps `search` in %...% but never escapes a literal % or _
    // within it, so a search term containing those characters keeps acting as a SQL LIKE
    // wildcard rather than matching them literally. Not a security bug — the value is still
    // bound as a query parameter, so injection isn't possible — just an over-matching precision
    // gap, pinned so a future fix that adds escaping is a deliberate, visible change.
    const marker = Date.now();
    const withPercent = await createCase(request, { title: `E2E Wildcard 100% Done ${marker}` });
    const withoutPercent = await createCase(request, { title: `E2E Wildcard 100X Done ${marker}` });

    try {
      const res = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, {
          params: { search: `100% Done ${marker}` },
        })
      ).json();
      expect(res.some((tc: { id: string }) => tc.id === withPercent.id)).toBeTruthy();
      expect(res.some((tc: { id: string }) => tc.id === withoutPercent.id)).toBeTruthy();
    } finally {
      await deleteCase(request, withPercent.id);
      await deleteCase(request, withoutPercent.id);
    }
  });
});

test.describe("filters", () => {
  test("filters by status, priority, and type independently", async ({ request }) => {
    const marker = Date.now();
    const a = await createCase(request, {
      title: `E2E Filter A ${marker}`,
      status: "In Review",
      priority: "P0",
      type: "Regression",
    });
    const b = await createCase(request, {
      title: `E2E Filter B ${marker}`,
      status: "Approved",
      priority: "P3",
      type: "Smoke",
    });

    try {
      const byStatus = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, { params: { status: "In Review" } })
      ).json();
      expect(byStatus.some((tc: { id: string }) => tc.id === a.id)).toBeTruthy();
      expect(byStatus.some((tc: { id: string }) => tc.id === b.id)).toBeFalsy();

      const byPriority = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, { params: { priority: "P3" } })
      ).json();
      expect(byPriority.some((tc: { id: string }) => tc.id === b.id)).toBeTruthy();
      expect(byPriority.some((tc: { id: string }) => tc.id === a.id)).toBeFalsy();

      const byType = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, { params: { type: "Smoke" } })
      ).json();
      expect(byType.some((tc: { id: string }) => tc.id === b.id)).toBeTruthy();
      expect(byType.some((tc: { id: string }) => tc.id === a.id)).toBeFalsy();
    } finally {
      await deleteCase(request, a.id);
      await deleteCase(request, b.id);
    }
  });

  test("filters by suiteId, automationStatus, jiraIssueKey and linearIssueKey", async ({ request }) => {
    const suite = await createSuite(request, `E2E Filter Suite ${Date.now()}`);
    const marker = Date.now();
    const inSuite = await createCase(request, {
      title: `E2E Filter InSuite ${marker}`,
      suiteId: suite.id,
      automationStatus: "Automated",
      jiraIssueKey: `JIRA${marker}`,
      linearIssueKey: `LIN${marker}`,
    });
    const outOfSuite = await createCase(request, { title: `E2E Filter OutOfSuite ${marker}` });

    try {
      const bySuite = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, { params: { suiteId: suite.id } })
      ).json();
      expect(bySuite.some((tc: { id: string }) => tc.id === inSuite.id)).toBeTruthy();
      expect(bySuite.some((tc: { id: string }) => tc.id === outOfSuite.id)).toBeFalsy();

      const byAutomation = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, {
          params: { automationStatus: "Automated" },
        })
      ).json();
      expect(byAutomation.some((tc: { id: string }) => tc.id === inSuite.id)).toBeTruthy();
      expect(byAutomation.some((tc: { id: string }) => tc.id === outOfSuite.id)).toBeFalsy();

      const byJira = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, {
          params: { jiraIssueKey: inSuite.jiraIssueKey },
        })
      ).json();
      expect(byJira.some((tc: { id: string }) => tc.id === inSuite.id)).toBeTruthy();

      const byLinear = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, {
          params: { linearIssueKey: inSuite.linearIssueKey },
        })
      ).json();
      expect(byLinear.some((tc: { id: string }) => tc.id === inSuite.id)).toBeTruthy();
    } finally {
      await deleteCase(request, inSuite.id);
      await deleteCase(request, outOfSuite.id);
      await deleteSuite(request, suite.id);
    }
  });

  test("suiteId=none filters to test cases with no suite assigned", async ({ request }) => {
    const suite = await createSuite(request, `E2E NoSuite Filter Suite ${Date.now()}`);
    const marker = Date.now();
    const inSuite = await createCase(request, { title: `E2E NoSuite InSuite ${marker}`, suiteId: suite.id });
    const unassigned = await createCase(request, { title: `E2E NoSuite Unassigned ${marker}` });

    try {
      const res = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
        params: { suiteId: "none" },
      });
      expect(res.ok()).toBeTruthy();
      const rows = await res.json();
      expect(rows.some((tc: { id: string }) => tc.id === unassigned.id)).toBeTruthy();
      expect(rows.some((tc: { id: string }) => tc.id === inSuite.id)).toBeFalsy();

      // Moving the unassigned case into the suite must remove it from the "no suite" filter —
      // proves the sentinel isn't just matching a literal suite_id of "none".
      await request.put(`/api/projects/${ctx.projectId}/testcases/${unassigned.id}`, {
        data: { suiteId: suite.id },
      });
      const afterMove = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, { params: { suiteId: "none" } })
      ).json();
      expect(afterMove.some((tc: { id: string }) => tc.id === unassigned.id)).toBeFalsy();
    } finally {
      await deleteCase(request, inSuite.id);
      await deleteCase(request, unassigned.id);
      await deleteSuite(request, suite.id);
    }
  });

  test("combining status and priority filters applies AND logic", async ({ request }) => {
    const marker = Date.now();
    const match = await createCase(request, { title: `E2E Combo Match ${marker}`, status: "In Review", priority: "P0" });
    const wrongPriority = await createCase(request, {
      title: `E2E Combo WrongPriority ${marker}`,
      status: "In Review",
      priority: "P3",
    });
    const wrongStatus = await createCase(request, {
      title: `E2E Combo WrongStatus ${marker}`,
      status: "Approved",
      priority: "P0",
    });

    try {
      const res = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, {
          params: { status: "In Review", priority: "P0" },
        })
      ).json();
      expect(res.some((tc: { id: string }) => tc.id === match.id)).toBeTruthy();
      expect(res.some((tc: { id: string }) => tc.id === wrongPriority.id)).toBeFalsy();
      expect(res.some((tc: { id: string }) => tc.id === wrongStatus.id)).toBeFalsy();
    } finally {
      await deleteCase(request, match.id);
      await deleteCase(request, wrongPriority.id);
      await deleteCase(request, wrongStatus.id);
    }
  });
});

test.describe("pagination", () => {
  test("limit controls page size while X-Total-Count reports the full filtered total", async ({ request }) => {
    const marker = `E2E Pagination ${Date.now()}`;
    const created: string[] = [];
    try {
      for (let i = 0; i < 5; i++) {
        created.push((await createCase(request, { title: `${marker} ${i}` })).id);
      }

      const pageRes = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
        params: { search: marker, limit: 2 },
      });
      expect(pageRes.ok()).toBeTruthy();
      const page = await pageRes.json();
      expect(page).toHaveLength(2);
      expect(pageRes.headers()["x-total-count"]).toBe("5");
    } finally {
      for (const id of created) await deleteCase(request, id);
    }
  });

  test("offset pages through results with no overlap, covering every fixture row exactly once", async ({
    request,
  }) => {
    const marker = `E2E Offset ${Date.now()}`;
    const created: string[] = [];
    try {
      for (let i = 0; i < 4; i++) {
        created.push((await createCase(request, { title: `${marker} ${i}` })).id);
      }

      const page1 = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, {
          params: { search: marker, limit: 2, offset: 0 },
        })
      ).json();
      const page2 = await (
        await request.get(`/api/projects/${ctx.projectId}/testcases`, {
          params: { search: marker, limit: 2, offset: 2 },
        })
      ).json();

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      const ids1 = page1.map((tc: { id: string }) => tc.id);
      const ids2 = page2.map((tc: { id: string }) => tc.id);
      expect(ids1.some((id: string) => ids2.includes(id))).toBeFalsy();
      expect(new Set([...ids1, ...ids2])).toEqual(new Set(created));
    } finally {
      for (const id of created) await deleteCase(request, id);
    }
  });

  test("limit=0 returns an empty page without affecting the reported total", async ({ request }) => {
    const marker = `E2E ZeroLimit ${Date.now()}`;
    const created = await createCase(request, { title: marker });

    try {
      const res = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
        params: { search: marker, limit: 0 },
      });
      expect(res.ok()).toBeTruthy();
      expect(await res.json()).toEqual([]);
      expect(res.headers()["x-total-count"]).toBe("1");
    } finally {
      await deleteCase(request, created.id);
    }
  });

  test("a negative limit or offset is floored instead of reaching the database", async ({ request }) => {
    /*
     * REWRITTEN, and this is the narrow case the tracker's §3 rule allows: the expectation itself was
     * documenting a defect. This test used to be titled "...is passed straight to the database with no
     * floor validation" and asserted that both requests FAIL, pinning the gap so it could not change
     * silently. It has now changed on purpose.
     *
     * `Number(query.limit || 100)` with no floor sent a negative straight into a LIMIT clause, and
     * `Number("abc")` sent NaN — Postgres rejects both, so a word or a minus sign in a query string was
     * a 500 on every paginated endpoint. pageNumber() in legacy.service.ts now corrects a non-number
     * and floors a negative, which is what this asserts.
     */
    const negatives: Array<Record<string, number>> = [{ limit: -1 }, { offset: -1 }, { limit: -50, offset: -50 }];
    for (const params of negatives) {
      const res = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
        params,
        failOnStatusCode: false,
      });
      expect(res.status(), `${JSON.stringify(params)} answered ${res.status()}: ${await res.text()}`).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
    }

    // A non-numeric page falls back to the default rather than erroring.
    const nonNumeric: Array<Record<string, string>> = [{ limit: "abc" }, { offset: "abc" }, { limit: "1e999" }];
    for (const params of nonNumeric) {
      const res = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
        params,
        failOnStatusCode: false,
      });
      expect(res.status(), `${JSON.stringify(params)} answered ${res.status()}: ${await res.text()}`).toBe(200);
    }

    // And the ceiling still holds, so a caller cannot ask for the whole table.
    const huge = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
      params: { limit: 100000 },
      failOnStatusCode: false,
    });
    expect(huge.status()).toBe(200);
    expect((await huge.json()).length).toBeLessThanOrEqual(500);
  });
});
