import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  createProject,
  deleteProjects,
  screensApi,
  screensSuiteSkipReason,
  screensTenant,
  seedRun,
} from "../utils/screens-tenant";

/*
 * The Reports & Insights screen at /projects/:id/reports — the export controls.
 *
 * Basecamp 10218723531 ("Reports & Insights > Export buttons are not working"). All three were dead:
 * the top bar's Export button and the nav's "Export CSV" / "Export PDF" rows were markup with
 * title="Coming soon" and no handler. The top bar and the nav's CSV/Excel rows are real exports now;
 * "Export PDF" was removed rather than wired, because no PDF pipeline exists to point it at.
 *
 * The recurring assertion is that the control is ALIVE — that nothing on this screen still carries
 * "Coming soon" or cursor-not-allowed — plus that each link asks for the view actually on screen.
 * The files themselves (headers, rows, filters, formats) are covered in api/reports.spec.ts.
 */

const tenant = screensTenant();
const skipReason = screensSuiteSkipReason(tenant);

test.use({ storageState: path.join(__dirname, "../.auth/state-screens.json") });

function exportButton(page: Page) {
  return page.getByTestId("reports-export");
}

/** Opens the top bar's export menu and returns it. */
async function openExportMenu(page: Page) {
  await exportButton(page).click();
  const menu = page.getByTestId("reports-export-menu");
  await expect(menu).toBeVisible();
  return menu;
}

test.describe("reports export controls", () => {
  let api: APIRequestContext;
  let projectId: string;

  test.beforeAll(async () => {
    if (skipReason) return;
    api = await screensApi();
    const project = await createProject(api);
    projectId = project.id;
    // One executed run, so the Execution Report tab has a filterable row rather than an empty state.
    await seedRun(api, projectId, { statuses: ["Passed", "Failed"], status: "Completed" });
  });

  test.afterAll(async () => {
    if (api) {
      await deleteProjects(api, [projectId]);
      await api.dispose();
    }
  });

  test.beforeEach(async ({ page }) => {
    test.skip(skipReason !== null, skipReason ?? "");
    await page.goto(`/projects/${projectId}/reports`);
    await expect(page.getByRole("heading", { name: "Reports & Insights" })).toBeVisible();
  });

  test("RPT-U-01 the Export button is a live control, not a Coming soon placeholder", { tag: '@tesbo.testId("TES-TC-1360")' }, async ({ page }) => {
    const button = exportButton(page);
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
    // The exact shape of the original defect: a title of "Coming soon" and a not-allowed cursor.
    await expect(button).not.toHaveAttribute("title", "Coming soon");
    expect(await button.evaluate((el) => getComputedStyle(el).cursor)).not.toBe("not-allowed");
    // And nothing anywhere on the screen still advertises an export that isn't built.
    await expect(page.locator('[title="Coming soon"]')).toHaveCount(0);
    await expect(page.getByText("Export PDF")).toHaveCount(0);
  });

  test("RPT-U-02 the menu offers CSV and Excel for the view on screen", { tag: '@tesbo.testId("TES-TC-1361")' }, async ({ page }) => {
    const menu = await openExportMenu(page);
    await expect(menu).toContainText("Overview");

    await expect(page.getByTestId("reports-export-csv")).toHaveAttribute(
      "href",
      /\/reports\/export\/csv\?view=overview/,
    );
    await expect(page.getByTestId("reports-export-xlsx")).toHaveAttribute(
      "href",
      /\/reports\/export\/xlsx\?view=overview/,
    );
  });

  test("RPT-U-03 switching tabs switches what gets exported", { tag: '@tesbo.testId("TES-TC-1362")' }, async ({ page }) => {
    // Six views share one button, so the link has to follow the nav — exporting the overview while
    // looking at Traceability is the quietly-wrong-file failure this guards.
    const cases: [string, string][] = [
      ["Execution Report", "execution"],
      ["Traceability", "matrix"],
      ["Repository", "repository"],
      ["AI Insights", "insights"],
      ["Trends", "trends"],
    ];
    for (const [navLabel, view] of cases) {
      await page.getByRole("button", { name: new RegExp(navLabel, "i") }).first().click();
      const menu = await openExportMenu(page);
      await expect(menu).toContainText(new RegExp(navLabel.split(" ")[0], "i"));
      await expect(page.getByTestId("reports-export-csv")).toHaveAttribute(
        "href",
        new RegExp(`view=${view}`),
      );
      // Close it again so the next iteration's click lands on the button, not the open menu.
      await page.keyboard.press("Escape");
      await page.mouse.click(5, 400);
    }
  });

  test("RPT-U-04 the nav's own export rows point at the same file", { tag: '@tesbo.testId("TES-TC-1363")' }, async ({ page }) => {
    await expect(page.getByTestId("reports-nav-export-csv")).toHaveAttribute(
      "href",
      /\/reports\/export\/csv\?view=overview/,
    );
    await expect(page.getByTestId("reports-nav-export-xlsx")).toHaveAttribute(
      "href",
      /\/reports\/export\/xlsx\?view=overview/,
    );
  });

  test("RPT-U-05 the CSV link really serves a file to this session", { tag: '@tesbo.testId("TES-TC-1364")' }, async ({ page }) => {
    /*
     * Followed with page.request rather than by clicking: the anchor opens in a new tab, and a
     * download that starts inside a popup emits its event on the popup rather than this page, which
     * makes the click-and-wait form flaky for reasons that have nothing to do with the export. Going
     * through page.request keeps the session cookie and still proves the whole path — the href the UI
     * built, the auth on it, the headers, and the first line of the file.
     */
    await openExportMenu(page);
    const href = (await page.getByTestId("reports-export-csv").getAttribute("href")) ?? "";
    expect(href).toBeTruthy();

    const res = await page.request.get(href);
    expect(res.status(), await res.text()).toBe(200);
    expect(res.headers()["content-disposition"]).toContain('filename="report-overview.csv"');
    const body = await res.text();
    expect(body.split("\n")[0]).toBe("section,label,metric,value");
    expect(body.length).toBeGreaterThan("section,label,metric,value".length);
  });

  test("RPT-U-06 the Execution Report's filter travels with its export", { tag: '@tesbo.testId("TES-TC-1365")' }, async ({ page }) => {
    await page.getByRole("button", { name: /Execution Report/i }).first().click();

    // The tab's "Filter by" select; its options are the grouping dimensions.
    const filterBy = page.locator("select").first();
    await filterBy.selectOption("priority");
    // The value select appears once a dimension other than "overall" is chosen.
    const filterValue = page.locator("select").nth(1);
    await expect(filterValue).toBeVisible();
    const option = (await filterValue.locator("option").nth(1).getAttribute("value")) ?? "";
    test.skip(!option, "this project has no priority buckets to filter by");
    await filterValue.selectOption(option);

    await openExportMenu(page);
    const href = (await page.getByTestId("reports-export-csv").getAttribute("href")) ?? "";
    expect(href).toContain("view=execution");
    expect(href).toContain("filterBy=priority");
    expect(href).toContain(`filterValue=${encodeURIComponent(option)}`);
  });
});
