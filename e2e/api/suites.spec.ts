import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));

test.describe("test suite CRUD", () => {
  test("supports create -> list -> rename -> reposition -> delete", { tag: '@tesbo.testId("TES-TC-527")' }, async ({ request }) => {
    const name = `E2E Suite ${Date.now()}`;
    const created = await (
      await request.post(`/api/projects/${ctx.projectId}/suites`, { data: { name } })
    ).json();

    try {
      expect(created.id).toBeTruthy();
      expect(created.parentId).toBeNull();
      expect(created.position).toBe(0);
      expect(created.testCaseCount).toBe(0);

      const listRes = await request.get(`/api/projects/${ctx.projectId}/suites`);
      const list = await listRes.json();
      expect(list.some((s: { id: string }) => s.id === created.id)).toBeTruthy();

      const renamedName = `${name} (renamed)`;
      const renameRes = await request.patch(`/api/suites/${created.id}`, {
        data: { name: renamedName },
      });
      expect(renameRes.ok()).toBeTruthy();

      const repositionRes = await request.patch(`/api/suites/${created.id}`, {
        data: { position: 5 },
      });
      expect(repositionRes.ok()).toBeTruthy();

      const listAfterRes = await request.get(`/api/projects/${ctx.projectId}/suites`);
      const listAfter = await listAfterRes.json();
      const updated = listAfter.find((s: { id: string }) => s.id === created.id);
      expect(updated.name).toBe(renamedName);
      expect(updated.position).toBe(5);
    } finally {
      await request.delete(`/api/suites/${created.id}`, { failOnStatusCode: false });
    }
  });

  test("renaming a child suite without sending parentId silently detaches it to root", { tag: '@tesbo.testId("TES-TC-528")' }, async ({
    request,
  }) => {
    // KNOWN GAP (documented, not test.fail() — this is a data-integrity bug, not a security
    // one): updateSuite (legacy.service.ts:1357) sets parent_id = $3 unconditionally, bound to
    // body.parentId ?? null, instead of COALESCE-ing like the adjacent `name` column does. The
    // rename UI only ever sends {name}, so every plain rename of a nested suite moves it to
    // root. Pinned here so this doesn't get silently "fixed" without anyone noticing the change.
    const parent = await (
      await request.post(`/api/projects/${ctx.projectId}/suites`, {
        data: { name: `E2E Parent Suite ${Date.now()}` },
      })
    ).json();
    const child = await (
      await request.post(`/api/projects/${ctx.projectId}/suites`, {
        data: { name: `E2E Child Suite ${Date.now()}`, parentId: parent.id },
      })
    ).json();

    try {
      expect(child.parentId).toBe(parent.id);

      await request.patch(`/api/suites/${child.id}`, { data: { name: "Renamed, no parentId sent" } });

      const listRes = await request.get(`/api/projects/${ctx.projectId}/suites`);
      const list = await listRes.json();
      const afterRename = list.find((s: { id: string }) => s.id === child.id);
      expect(afterRename.parentId).toBeNull();
    } finally {
      await request.delete(`/api/suites/${child.id}`, { failOnStatusCode: false });
      await request.delete(`/api/suites/${parent.id}`, { failOnStatusCode: false });
    }
  });

  test("deleting a suite with mode=moveToDefault un-suites its test cases instead of removing them", { tag: '@tesbo.testId("TES-TC-529")' }, async ({
    request,
  }) => {
    const suite = await (
      await request.post(`/api/projects/${ctx.projectId}/suites`, {
        data: { name: `E2E Suite To Delete ${Date.now()}` },
      })
    ).json();
    const testcase = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: `E2E Suite Delete Test Case ${Date.now()}`, suiteId: suite.id },
      })
    ).json();

    try {
      const deleteRes = await request.delete(`/api/suites/${suite.id}`, {
        params: { mode: "moveToDefault" },
      });
      expect(deleteRes.ok()).toBeTruthy();

      const getRes = await request.get(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`);
      expect(getRes.ok()).toBeTruthy();
      expect((await getRes.json()).suiteId).toBeNull();
    } finally {
      await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`, {
        failOnStatusCode: false,
      });
    }
  });

  test("deleting a suite with mode=deleteTestcases removes its test cases entirely", { tag: '@tesbo.testId("TES-TC-530")' }, async ({
    request,
  }) => {
    const suite = await (
      await request.post(`/api/projects/${ctx.projectId}/suites`, {
        data: { name: `E2E Suite Hard Delete ${Date.now()}` },
      })
    ).json();
    const testcase = await (
      await request.post(`/api/projects/${ctx.projectId}/testcases`, {
        data: { title: `E2E Suite Hard Delete Test Case ${Date.now()}`, suiteId: suite.id },
      })
    ).json();

    const deleteRes = await request.delete(`/api/suites/${suite.id}`, {
      params: { mode: "deleteTestcases" },
    });
    expect(deleteRes.ok()).toBeTruthy();

    const getRes = await request.get(`/api/projects/${ctx.projectId}/testcases/${testcase.id}`, {
      failOnStatusCode: false,
    });
    expect(getRes.status()).toBe(404);
  });
});
