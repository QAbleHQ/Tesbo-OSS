import fs from "node:fs";
import path from "node:path";
import { expect, request as pwRequest, test } from "@playwright/test";
import { env } from "../utils/env";

const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));
const STATE_PATH = path.join(__dirname, "../.auth/state.json");

async function setUpCycleWithOneCase(title: string) {
  const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
  const cycle = await (
    await api.post(`/api/projects/${ctx.projectId}/cycles`, { data: { name: `UI Bug Dialog Cycle ${Date.now()}` } })
  ).json();
  // The inline status <select> only renders when the run's own status is "In Progress"
  // (page.tsx: `const isInProgress = run.status === "In Progress"`) — cycles are created in
  // "Planning" by default (migrations/V9_cycle_status.sql), so this must be set explicitly.
  await api.patch(`/api/cycles/${cycle.id}`, { data: { status: "In Progress" } });
  const testcase = await (
    await api.post(`/api/projects/${ctx.projectId}/testcases`, { data: { title } })
  ).json();
  await api.post(`/api/cycles/${cycle.id}/testcases`, { data: { testcaseIds: [testcase.id] } });
  await api.dispose();
  return { cycle, testcase };
}

async function cleanUp(cycleId: string, testcaseId: string) {
  const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
  try {
    const bugsRes = await api.get(`/api/projects/${ctx.projectId}/bugs`);
    const bugs = await bugsRes.json();
    for (const bug of bugs) {
      if (bug.links?.some((l: { testcaseId: string }) => l.testcaseId === testcaseId)) {
        await api.delete(`/api/bugs/${bug.id}`);
      }
    }
    await api.delete(`/api/cycles/${cycleId}`, { failOnStatusCode: false });
    await api.delete(`/api/projects/${ctx.projectId}/testcases/${testcaseId}`, { failOnStatusCode: false });
  } finally {
    await api.dispose();
  }
}

test.describe("auto bug-filing on Failed", () => {
  test("marking an execution Failed opens the bug dialog, and filing creates a linked bug", async ({
    page,
  }) => {
    const title = `UI Bug Dialog Test Case ${Date.now()}`;
    const { cycle, testcase } = await setUpCycleWithOneCase(title);

    try {
      await page.goto(`/projects/${ctx.projectId}/cycles/${cycle.id}`);
      await page.getByRole("combobox").first().selectOption("Failed");

      await expect(page.getByRole("heading", { name: "Report a Bug" })).toBeVisible();
      const titleInput = page.getByPlaceholder("Brief summary of the bug…");
      await expect(titleInput).toHaveValue(`Failed: ${title}`);

      await page.getByRole("button", { name: "File Bug" }).click();
      await expect(page.getByRole("heading", { name: "Report a Bug" })).toBeHidden();

      const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
      try {
        const bugsRes = await api.get(`/api/projects/${ctx.projectId}/bugs`);
        const bugs = await bugsRes.json();
        const filedBug = bugs.find((b: { title: string }) => b.title === `Failed: ${title}`);
        expect(filedBug).toBeTruthy();
        expect(filedBug.links.some((l: { testcaseId: string; cycleId: string }) =>
          l.testcaseId === testcase.id && l.cycleId === cycle.id,
        )).toBeTruthy();
      } finally {
        await api.dispose();
      }
    } finally {
      await cleanUp(cycle.id, testcase.id);
    }
  });

  test("skipping the dialog leaves the execution Failed with no bug filed", async ({ page }) => {
    const title = `UI Bug Dialog Declined Test Case ${Date.now()}`;
    const { cycle, testcase } = await setUpCycleWithOneCase(title);

    try {
      await page.goto(`/projects/${ctx.projectId}/cycles/${cycle.id}`);
      await page.getByRole("combobox").first().selectOption("Failed");

      await expect(page.getByRole("heading", { name: "Report a Bug" })).toBeVisible();
      await page.getByRole("button", { name: "Skip", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Report a Bug" })).toBeHidden();

      const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
      try {
        const bugsRes = await api.get(`/api/projects/${ctx.projectId}/bugs`);
        const bugs = await bugsRes.json();
        expect(bugs.some((b: { title: string }) => b.title === `Failed: ${title}`)).toBeFalsy();

        const executionsRes = await api.get(`/api/cycles/${cycle.id}/executions`);
        const executions = await executionsRes.json();
        expect(executions[0].status).toBe("Failed");
      } finally {
        await api.dispose();
      }
    } finally {
      await cleanUp(cycle.id, testcase.id);
    }
  });
});

test.describe("removing cases from a run", () => {
  /*
   * Basecamp 10199377404 — "[Test Run] Count does not match when deleted test cases from run". The
   * reported screen showed "Total 10" and "Test Cases 10" in the run body while the left panel's badge
   * for that same run still read 11.
   *
   * The API was already right — listCycles counts live execution rows, and api/cycles.spec.ts pins
   * `totalCases === executions.length`. The bug was entirely in the screen: the removal handlers
   * filtered the local `executions` array (which drives the body) but `allRuns` (which drives the
   * panel badge) was only ever fetched by load() on mount, so the badge kept the pre-delete number.
   *
   * Asserted against the badge AND the body together, because either number alone looked correct — it
   * was only their disagreement that was wrong.
   */
  async function setUpCycleWithCases(count: number) {
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    const stamp = Date.now();
    const cycle = await (
      await api.post(`/api/projects/${ctx.projectId}/cycles`, { data: { name: `UI Run Count ${stamp}` } })
    ).json();
    await api.patch(`/api/cycles/${cycle.id}`, { data: { status: "In Progress" } });
    const testcaseIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const tc = await (
        await api.post(`/api/projects/${ctx.projectId}/testcases`, {
          data: { title: `UI Run Count case ${i + 1} ${stamp}` },
        })
      ).json();
      testcaseIds.push(tc.id);
    }
    await api.post(`/api/cycles/${cycle.id}/testcases`, { data: { testcaseIds } });
    await api.dispose();
    return { cycle, testcaseIds };
  }

  test("the run panel's count follows a removal, and never disagrees with the run's own Total", async ({
    page,
  }) => {
    const { cycle, testcaseIds } = await setUpCycleWithCases(3);
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    try {
      await page.goto(`/projects/${ctx.projectId}/cycles/${cycle.id}`);

      const badge = page.locator(`[data-testid="run-list-count"][data-run-id="${cycle.id}"]`);
      // The count beside the "Test Cases" heading — the run body's own number.
      const bodyCount = page.getByRole("heading", { name: "Test Cases" }).locator("+ span");

      await expect(badge, "the run panel shows no count for this run").toHaveText("3");
      await expect(bodyCount).toHaveText("3");

      // Remove one case through the row's own control, the way the reporter did. The control only
      // appears on hover (opacity-0 until group-hover), so the row is hovered first.
      const firstRow = page.getByRole("row").filter({ hasText: "UI Run Count case 1" });
      await expect(firstRow).toBeVisible();
      await firstRow.hover();
      await firstRow.getByTitle("Remove from test run").click();

      // The body drops to 2 — that half always worked.
      await expect(bodyCount).toHaveText("2", { timeout: 15_000 });
      // And the panel badge follows it. This is the assertion that failed before the fix.
      await expect(
        badge,
        "the run panel's count did not follow the removal — it disagrees with the run's own Total",
      ).toHaveText("2");

      // Persisted, not just repainted: the server agrees the run now holds 2.
      const listed = await (await api.get(`/api/projects/${ctx.projectId}/cycles`)).json();
      const thisRun = listed.find((r: { id: string }) => r.id === cycle.id);
      expect(thisRun.totalCases, "the server still reports the pre-delete count").toBe(2);
    } finally {
      await api.delete(`/api/cycles/${cycle.id}`, { failOnStatusCode: false });
      for (const id of testcaseIds) {
        await api.delete(`/api/projects/${ctx.projectId}/testcases/${id}`, { failOnStatusCode: false });
      }
      await api.dispose();
    }
  });
});
