import fs from "node:fs";
import path from "node:path";
import { expect, request as pwRequest, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { env } from "../utils/env";

const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));
const STATE_PATH = path.join(__dirname, "../.auth/state.json");

/*
 * The bugs screen at /projects/:id/bugs — the status filter and search box shared by the Board
 * (kanban) and List views.
 *
 * Reported: the status Select was only rendered while viewMode === "list", but the filtered list it
 * controlled (`filtered`, used by both the List rows and the Board's kanbanColumns) applied
 * filterStatus regardless of which view was showing. So a filter set in List kept silently narrowing
 * Board after switching — with no control visible there to see it was active or clear it — while
 * Search (never gated on viewMode) already behaved consistently across both. The fix renders the
 * same Select in both views, matching Search's existing behaviour.
 *
 * These tests share the project the whole suite runs against (ctx.projectId is a Launch-plan
 * workspace capped at 2 projects, so a dedicated project per test isn't an option here). Assertions
 * are written to hold regardless of concurrent bugs other spec files create in that project:
 * presence/absence is always checked by this test's own uniquely-named bugs, and the only "a whole
 * column is empty" assertions are for statuses a given filter provably excludes for every bug in the
 * project, not just the ones a test made itself.
 */

let uniqueCounter = 0;
function uniqueSuffix(): string {
  uniqueCounter += 1;
  return `${Date.now()}-${uniqueCounter}`;
}

function kanbanColumn(page: Page, status: string): Locator {
  return page
    .getByRole("heading", { name: status, exact: true })
    .locator("xpath=ancestor::div[contains(@class,'min-w-')][1]");
}

async function createBug(
  api: APIRequestContext,
  title: string,
  status: "Open" | "In Progress" | "Closed" | "Reopened" = "Open",
): Promise<string> {
  const created = await (
    await api.post(`/api/projects/${ctx.projectId}/bugs`, { data: { title, severity: "Medium" } })
  ).json();
  if (status !== "Open") {
    await api.patch(`/api/bugs/${created.id}`, { data: { status } });
  }
  return created.id;
}

async function deleteBug(api: APIRequestContext, id: string | undefined): Promise<void> {
  if (id) await api.delete(`/api/bugs/${id}`, { failOnStatusCode: false });
}

test.describe("bugs — status filter and search consistency across Board and List", () => {
  let api: APIRequestContext;
  test.beforeAll(async () => {
    api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
  });
  test.afterAll(async () => {
    await api?.dispose();
  });

  test("BUG-U-01 a status filter applied in List stays visible and applied after switching to Board", async ({
    page,
  }) => {
    const openTitle = `E2E Bug Filter Open ${uniqueSuffix()}`;
    const inProgressTitle = `E2E Bug Filter InProgress ${uniqueSuffix()}`;
    let openId: string | undefined;
    let inProgressId: string | undefined;
    try {
      openId = await createBug(api, openTitle, "Open");
      inProgressId = await createBug(api, inProgressTitle, "In Progress");

      await page.goto(`/projects/${ctx.projectId}/bugs`);
      await page.getByRole("button", { name: "List" }).click();

      const statusFilter = page.getByRole("combobox");
      await statusFilter.selectOption("Open");
      await expect(page.getByText(openTitle, { exact: true })).toBeVisible();
      await expect(page.getByText(inProgressTitle, { exact: true })).toHaveCount(0);

      await page.getByRole("button", { name: "Board" }).click();

      // The regression itself: the control that shows/edits the filter must still be there and
      // still reflect "Open" — not just the filtering effect, but visible evidence of why it's
      // happening.
      await expect(statusFilter).toBeVisible();
      await expect(statusFilter).toHaveValue("Open");

      // Filtered to Open, so every other column is empty for every bug in the project, not only ours.
      await expect(kanbanColumn(page, "In Progress").getByText("No bugs")).toBeVisible();
      await expect(kanbanColumn(page, "Reopened").getByText("No bugs")).toBeVisible();
      await expect(kanbanColumn(page, "Closed").getByText("No bugs")).toBeVisible();
      await expect(kanbanColumn(page, "Open").getByText(openTitle, { exact: true })).toBeVisible();
      await expect(page.getByText(inProgressTitle, { exact: true })).toHaveCount(0);
    } finally {
      await deleteBug(api, openId);
      await deleteBug(api, inProgressId);
    }
  });

  test("BUG-U-02 the filter round-trips back to List unchanged", async ({ page }) => {
    const openTitle = `E2E Bug Filter Open ${uniqueSuffix()}`;
    const inProgressTitle = `E2E Bug Filter InProgress ${uniqueSuffix()}`;
    let openId: string | undefined;
    let inProgressId: string | undefined;
    try {
      openId = await createBug(api, openTitle, "Open");
      inProgressId = await createBug(api, inProgressTitle, "In Progress");

      await page.goto(`/projects/${ctx.projectId}/bugs`);
      const statusFilter = page.getByRole("combobox");
      await statusFilter.selectOption("In Progress");
      await expect(kanbanColumn(page, "In Progress").getByText(inProgressTitle, { exact: true })).toBeVisible();

      await page.getByRole("button", { name: "List" }).click();
      await expect(statusFilter).toHaveValue("In Progress");
      await expect(page.getByText(inProgressTitle, { exact: true })).toBeVisible();
      await expect(page.getByText(openTitle, { exact: true })).toHaveCount(0);

      await page.getByRole("button", { name: "Board" }).click();
      await expect(statusFilter).toHaveValue("In Progress");
    } finally {
      await deleteBug(api, openId);
      await deleteBug(api, inProgressId);
    }
  });

  test("BUG-U-03 a filter that excludes both of this test's bugs hides them in both views", async ({ page }) => {
    const openTitle = `E2E Bug Filter Open ${uniqueSuffix()}`;
    const inProgressTitle = `E2E Bug Filter InProgress ${uniqueSuffix()}`;
    let openId: string | undefined;
    let inProgressId: string | undefined;
    try {
      openId = await createBug(api, openTitle, "Open");
      inProgressId = await createBug(api, inProgressTitle, "In Progress");

      await page.goto(`/projects/${ctx.projectId}/bugs`);
      const statusFilter = page.getByRole("combobox");
      await statusFilter.selectOption("Closed");

      await expect(page.getByText(openTitle, { exact: true })).toHaveCount(0);
      await expect(page.getByText(inProgressTitle, { exact: true })).toHaveCount(0);
      await expect(kanbanColumn(page, "Open").getByText("No bugs")).toBeVisible();
      await expect(kanbanColumn(page, "In Progress").getByText("No bugs")).toBeVisible();

      await page.getByRole("button", { name: "List" }).click();
      await expect(page.getByText(openTitle, { exact: true })).toHaveCount(0);
      await expect(page.getByText(inProgressTitle, { exact: true })).toHaveCount(0);
    } finally {
      await deleteBug(api, openId);
      await deleteBug(api, inProgressId);
    }
  });

  test("BUG-U-04 clearing the filter back to All Statuses from Board restores both bugs", async ({ page }) => {
    const openTitle = `E2E Bug Filter Open ${uniqueSuffix()}`;
    const inProgressTitle = `E2E Bug Filter InProgress ${uniqueSuffix()}`;
    let openId: string | undefined;
    let inProgressId: string | undefined;
    try {
      openId = await createBug(api, openTitle, "Open");
      inProgressId = await createBug(api, inProgressTitle, "In Progress");

      await page.goto(`/projects/${ctx.projectId}/bugs`);
      const statusFilter = page.getByRole("combobox");
      await statusFilter.selectOption("Open");
      await expect(page.getByText(inProgressTitle, { exact: true })).toHaveCount(0);

      // Clearing is only possible from Board because the control used to be hidden there — this is
      // the concrete edge case the "keep them consistent" fix has to unblock.
      await statusFilter.selectOption("");
      await expect(statusFilter).toHaveValue("");
      await expect(kanbanColumn(page, "Open").getByText(openTitle, { exact: true })).toBeVisible();
      await expect(kanbanColumn(page, "In Progress").getByText(inProgressTitle, { exact: true })).toBeVisible();
    } finally {
      await deleteBug(api, openId);
      await deleteBug(api, inProgressId);
    }
  });

  test("BUG-U-05 a search term persists and keeps filtering after switching views", async ({ page }) => {
    const openTitle = `E2E Bug Search ${uniqueSuffix()}`;
    const otherTitle = `E2E Bug Search Other ${uniqueSuffix()}`;
    let openId: string | undefined;
    let otherId: string | undefined;
    try {
      openId = await createBug(api, openTitle);
      otherId = await createBug(api, otherTitle);

      await page.goto(`/projects/${ctx.projectId}/bugs`);
      const search = page.getByPlaceholder("Search bugs…");
      await search.fill(openTitle);

      await expect(page.getByText(openTitle, { exact: true })).toBeVisible();
      await expect(page.getByText(otherTitle, { exact: true })).toHaveCount(0);

      await page.getByRole("button", { name: "List" }).click();
      await expect(search).toHaveValue(openTitle);
      await expect(page.getByText(openTitle, { exact: true })).toBeVisible();
      await expect(page.getByText(otherTitle, { exact: true })).toHaveCount(0);
    } finally {
      await deleteBug(api, openId);
      await deleteBug(api, otherId);
    }
  });
});
