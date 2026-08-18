import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { literal, scalar } from "../utils/psql";
import {
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  writeStorageState,
  type RbacTenant,
} from "../utils/rbac-tenant";

/*
 * The test case repository screen at /projects/:id/testcases — its header counters, its search box,
 * and its column picker.
 *
 * Three reported tickets:
 *
 *   - BetterBugs 6a7c17a8 — "Test Case Repository count is not updated after deleting test cases".
 *     The screen reports the same number in four places (the TOTAL/DRAFT/APPROVED/DEPRECATED stat
 *     cards, the "N test cases across M suites" subtitle, the suite tree's per-suite counts, and the
 *     "N results" footer) and the report is that they stop agreeing with reality after a delete.
 *     TCR-01..04 assert all four move together, after a single delete and after a bulk one.
 *   - BetterBugs 6a7c1f86 — "Can we have search clear button". There is none: the input is a bare
 *     `<input>` with a magnifier icon and nothing to empty it, so clearing a search means selecting
 *     the text by hand. TCR-05 is expected RED. (The knowledge base screen next door already has a
 *     "Clear" control, so this is an inconsistency as well as a gap.)
 *   - BetterBugs 6a7c217f — "User is able to unselect all Columns types", with the reporter's note
 *     "3 status should not changeable / ID, TC title, Priority". `toggleColumnVisible` has no notion
 *     of a locked column, so every field including ID and the title can be switched off, leaving a
 *     table of bare checkboxes. TCR-06..07 are expected RED.
 *
 * Why its own disposable workspace ("repo-ui"): the header counters are ABSOLUTE numbers for the
 * whole project. Any other spec creating or deleting a case in the same project moves them
 * mid-assertion, and spec files run concurrently. This screen cannot share a project with anything.
 *
 * Locator notes:
 *   - A row's title cell is a button (see ui/testcases-pagination.spec.ts), so rows are located by
 *     `getByRole("button", { name: title })`.
 *   - The pagination footer carries `data-testid="testcases-pagination"` and holds the "N results".
 *   - The Columns control is PORTALED out of the table into the filter bar, so it is found on the
 *     page rather than inside the table element.
 *   - Search is debounced 250ms into `debouncedSuiteSearch`; assertions wait on the row set, not a
 *     fixed delay.
 */

test.describe("test case repository (UI)", () => {
  let tenant: RbacTenant | null = null;
  let api: APIRequestContext;
  let ownerState = "";
  const contexts: BrowserContext[] = [];

  /** Cases seeded per test, removed in afterEach so every test starts from a known total. */
  let seededIds: string[] = [];

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("repo-ui");
    if (!tenant) return;
    api = await loginAs(tenant.owner);
    ownerState = await writeStorageState(tenant.owner, "repo-ui-owner");
    await purgeCases();
  });

  test.afterAll(async () => {
    if (tenant) await purgeCases();
    if (api) await api.dispose();
    await Promise.all(contexts.map((ctx) => ctx.close()));
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  test.afterEach(async () => {
    if (tenant) await purgeCases();
    seededIds = [];
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Empties the project of test cases and suites.
   *
   * Through the API, not psql, so soft-delete semantics and the `testcases_active` view stay exactly
   * what the product does — a hand-written DELETE would leave the counters reading from a state the
   * product can never actually produce.
   */
  async function purgeCases(): Promise<void> {
    const listed = await api.get(`/api/projects/${tenant!.mainProjectId}/testcases`, {
      params: { limit: 200, offset: 0 },
      failOnStatusCode: false,
    });
    if (listed.ok()) {
      const ids = (await listed.json()).map((tc: { id: string }) => tc.id);
      if (ids.length) {
        await api.post(`/api/projects/${tenant!.mainProjectId}/testcases/bulk-delete`, {
          data: { testcaseIds: ids },
          failOnStatusCode: false,
        });
      }
    }
    const suites = await api.get(`/api/projects/${tenant!.mainProjectId}/suites`, { failOnStatusCode: false });
    if (suites.ok()) {
      for (const suite of await suites.json()) {
        await api.delete(`/api/projects/${tenant!.mainProjectId}/suites/${suite.id}`, { failOnStatusCode: false });
      }
    }
  }

  function stamp(label: string): string {
    return `E2E ${label} ${Date.now()}${Math.floor(Math.random() * 1000)}`;
  }

  async function seedSuite(name: string): Promise<string> {
    const res = await api.post(`/api/projects/${tenant!.mainProjectId}/suites`, { data: { name } });
    expect(res.ok(), `seeding suite ${name} — ${await res.text()}`).toBeTruthy();
    return (await res.json()).id;
  }

  async function seedCase(title: string, extra: Record<string, unknown> = {}): Promise<string> {
    const res = await api.post(`/api/projects/${tenant!.mainProjectId}/testcases`, {
      data: { title, ...extra },
    });
    expect(res.ok(), `seeding case ${title} — ${await res.text()}`).toBeTruthy();
    const id = (await res.json()).id;
    seededIds.push(id);
    return id;
  }

  /** The live count straight from the database, as the yardstick every screen number is held to. */
  function storedCaseCount(): number {
    return Number(
      scalar(
        `SELECT COUNT(*) FROM testcases WHERE project_id = ${literal(tenant!.mainProjectId)} AND deleted_at IS NULL;`,
      ),
    );
  }

  async function openRepository(browser: Browser): Promise<Page> {
    const ctx = await browser.newContext({ storageState: ownerState });
    contexts.push(ctx);
    const page = await ctx.newPage();
    await page.goto(`/projects/${tenant!.mainProjectId}/testcases`);
    await expect(page.getByRole("heading", { name: "Test case repository", level: 1 })).toBeVisible();
    return page;
  }

  function pagination(page: Page): Locator {
    return page.getByTestId("testcases-pagination");
  }

  /** The number printed above a stat card's label ("Total", "Draft", "Approved", "Deprecated"). */
  async function statCard(page: Page, label: string): Promise<number> {
    const value = await page.evaluate((wanted) => {
      const labelEl = Array.from(document.querySelectorAll("div")).find(
        (d) => d.textContent?.trim().toLowerCase() === (wanted as string).toLowerCase() && d.children.length === 0,
      );
      return labelEl?.previousElementSibling?.textContent?.trim() ?? "";
    }, label);
    return Number(value);
  }

  function subtitle(page: Page): Locator {
    return page.getByText(/\d+ test cases? across \d+ suites?/);
  }

  function searchBox(page: Page): Locator {
    return page.getByPlaceholder("Search by ID, title, or type");
  }

  function row(page: Page, title: string): Locator {
    return page.getByRole("button", { name: title });
  }

  /** Selects rows by ticking their checkboxes, then runs a bulk action to completion. */
  async function bulkDelete(page: Page, titles: string[]): Promise<void> {
    for (const title of titles) {
      const tableRow = page.getByRole("row").filter({ hasText: title });
      await tableRow.getByRole("checkbox").first().check();
    }
    await expect(page.getByText(`${titles.length} selected`)).toBeVisible();
    await page.getByRole("button", { name: "Bulk actions" }).click();
    await page.getByRole("combobox").filter({ hasText: /Select an action/ }).selectOption("delete");
    await expect(page.getByText(/permanently deletes the selected test cases/)).toBeVisible();
    await page.getByRole("button", { name: "Confirm" }).click();
  }

  // ─── The counters after a delete ───────────────────────────────────────────

  test("TCR-01 every counter on the screen agrees before anything is deleted", async ({ browser }) => {
    const suiteName = stamp("CountSuite");
    const suiteId = await seedSuite(suiteName);
    const titles = [stamp("CountA"), stamp("CountB"), stamp("CountC")];
    for (const title of titles) await seedCase(title, { suiteId, status: "Approved" });

    const page = await openRepository(browser);

    expect(storedCaseCount()).toBe(3);
    expect(await statCard(page, "Total")).toBe(3);
    expect(await statCard(page, "Approved")).toBe(3);
    await expect(subtitle(page)).toContainText("3 test cases");
    await expect(pagination(page)).toContainText("3 results");
  });

  test("TCR-02 deleting one test case decrements every counter", async ({ browser }) => {
    const suiteId = await seedSuite(stamp("DeleteOneSuite"));
    const titles = [stamp("DelA"), stamp("DelB"), stamp("DelC")];
    for (const title of titles) await seedCase(title, { suiteId, status: "Approved" });

    const page = await openRepository(browser);
    await expect(pagination(page)).toContainText("3 results");

    await bulkDelete(page, [titles[0]]);

    // The row goes, and so must every number that described it. The reported bug is precisely that
    // the row disappeared while the counters kept the old figure.
    await expect(row(page, titles[0])).toHaveCount(0);
    await expect(pagination(page)).toContainText("2 results");
    await expect(subtitle(page)).toContainText("2 test cases");
    await expect.poll(() => statCard(page, "Total"), { message: "the TOTAL card follows the delete" }).toBe(2);
    await expect.poll(() => statCard(page, "Approved")).toBe(2);
    expect(storedCaseCount(), "and the screen agrees with the database").toBe(2);
  });

  test("TCR-03 a bulk delete decrements every counter by the number removed", async ({ browser }) => {
    const suiteId = await seedSuite(stamp("BulkDeleteSuite"));
    const titles = [stamp("BulkA"), stamp("BulkB"), stamp("BulkC"), stamp("BulkD"), stamp("BulkE")];
    for (const title of titles) await seedCase(title, { suiteId, status: "Approved" });

    const page = await openRepository(browser);
    await expect(pagination(page)).toContainText("5 results");

    await bulkDelete(page, titles.slice(0, 3));

    await expect(pagination(page)).toContainText("2 results");
    await expect(subtitle(page)).toContainText("2 test cases");
    await expect.poll(() => statCard(page, "Total")).toBe(2);
    expect(storedCaseCount()).toBe(2);
    for (const gone of titles.slice(0, 3)) await expect(row(page, gone)).toHaveCount(0);
    for (const kept of titles.slice(3)) await expect(row(page, kept)).toBeVisible();
  });

  test("TCR-04 the suite tree's count follows a delete too", async ({ browser }) => {
    const suiteName = stamp("TreeCountSuite");
    const suiteId = await seedSuite(suiteName);
    const titles = [stamp("TreeA"), stamp("TreeB"), stamp("TreeC")];
    for (const title of titles) await seedCase(title, { suiteId, status: "Approved" });

    const page = await openRepository(browser);
    const suiteRow = page.getByRole("button", { name: new RegExp(suiteName) });
    await expect(suiteRow).toContainText("3");

    await bulkDelete(page, [titles[0], titles[1]]);

    // The tree is rendered from a separate fetch to the table's, which is exactly how the two came
    // to disagree in the report.
    await expect
      .poll(async () => (await suiteRow.textContent())?.includes("1"), {
        message: "the suite's own count follows the delete",
      })
      .toBe(true);
    await expect(page.getByText("All test cases").locator("..")).toContainText("1");
  });

  test("TCR-05 the search box offers a control to clear it", async ({ browser }) => {
    const titles = [stamp("ClearHit"), stamp("ClearMiss")];
    for (const title of titles) await seedCase(title);

    const page = await openRepository(browser);
    await expect(pagination(page)).toContainText("2 results");

    await searchBox(page).fill(titles[0]);
    await expect(row(page, titles[1])).toHaveCount(0);

    /*
     * The control has to live with the search box and has to be reachable without a keyboard — the
     * reporter's complaint was having to select the text by hand to get back to the full list.
     *
     * Scoped to the search box's own container so the filter chips' X buttons and the bulk bar's
     * "Clear selection" cannot satisfy this by accident: neither empties the search.
     */
    const searchGroup = page.locator("label").filter({ has: searchBox(page) });
    const clearControl = searchGroup
      .getByRole("button")
      .or(searchGroup.locator('[aria-label*="lear" i]'))
      .first();

    await expect(clearControl, "no way to clear the search without editing the text by hand").toBeVisible();

    await clearControl.click();
    await expect(searchBox(page)).toHaveValue("");
    await expect(row(page, titles[1]), "clearing restores the hidden rows").toBeVisible();
    await expect(pagination(page)).toContainText("2 results");
  });

  // ─── The column picker ─────────────────────────────────────────────────────

  test("TCR-06 ID, title and priority cannot be switched off", async ({ browser }) => {
    await seedCase(stamp("ColumnsCase"));
    const page = await openRepository(browser);

    await page.getByRole("button", { name: "Columns" }).click();

    // The reporter's note names these three: without an ID or a title a row cannot be identified at
    // all, and the screenshot shows a table of bare checkboxes once they are all off.
    for (const label of ["ID", "Test case title", "Priority"]) {
      const checkbox = page.getByRole("checkbox").and(page.locator(`xpath=//label[.//span[text()=${JSON.stringify(label)}]]//input`));
      await expect(checkbox, `${label} should be present in the picker`).toHaveCount(1);
      await expect(checkbox, `${label} must start visible`).toBeChecked();
      await expect(checkbox, `${label} must not be de-selectable`).toBeDisabled();
    }
  });

  test("TCR-07 the table can never be left with no data columns", async ({ browser }) => {
    const title = stamp("NoBlankTable");
    await seedCase(title);
    const page = await openRepository(browser);

    await page.getByRole("button", { name: "Columns" }).click();

    // Turn off everything the picker will let us turn off.
    const checkboxes = page.getByRole("checkbox", { disabled: false });
    for (let i = (await checkboxes.count()) - 1; i >= 0; i--) {
      const box = checkboxes.nth(i);
      if (await box.isChecked()) await box.uncheck();
    }
    await page.keyboard.press("Escape");

    // Whatever the picker allowed, the row must still identify itself. A table of nothing but
    // selection checkboxes is not a state the user should be able to reach.
    await expect(row(page, title), "the row must still be identifiable").toBeVisible();
    const headers = page.getByRole("columnheader");
    expect(await headers.count(), "at least one data column must survive").toBeGreaterThan(1);
  });
});
