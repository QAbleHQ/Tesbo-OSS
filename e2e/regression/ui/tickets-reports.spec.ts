import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { accountA, apiContext, cleanupRun, seedRun, ticket, unique, type SeededRun } from "../fixtures";

/*
 * Reported-ticket regression for the Reports & Insights screen's export controls.
 * Card 10218723531 — "Reports & Insights > Export buttons are not working".
 *
 * All three controls were dead: the top bar's Export button and the nav's "Export CSV" / "Export
 * PDF" rows were markup with title="Coming soon" and no handler. The top bar and the nav's
 * CSV/Excel rows are real exports now; "Export PDF" was REMOVED rather than wired, because no PDF
 * pipeline exists to point it at — which is the right resolution for an unbuilt feature and is
 * asserted here so it cannot creep back as a placeholder.
 *
 * ui/reports.spec.ts covers this already but is pinned to `.auth/state-screens.json`, so on a
 * deployed environment it skips — see regression/api/tickets-reports.spec.ts for the full reasoning.
 * The files themselves are asserted there; this file is about whether the control on screen is alive
 * and points at the view the user is actually looking at.
 */

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

test.describe("reports export controls — reported ticket 10218723531", () => {
  let api: APIRequestContext;
  let projectId: string;
  let run: SeededRun | undefined;

  test.beforeAll(async () => {
    api = await apiContext();
    projectId = accountA().projectId;
    // One executed run, so the Execution Report tab has a filterable row rather than an empty state.
    run = await seedRun(api, projectId, {
      statuses: ["Passed", "Failed"],
      status: "Completed",
      name: unique("Reports Run"),
    });
  });

  test.afterAll(async () => {
    await cleanupRun(api, projectId, run);
    await api.dispose();
  });

  test.beforeEach(async ({ page }) => {
    await page.goto(`/projects/${projectId}/reports`);
    await expect(page.getByRole("heading", { name: "Reports & Insights" })).toBeVisible();
  });

  test(
    ticket("REG-RPT-U-01", "10218723531", "the Export button is a live control, not a Coming soon placeholder"),
    { tag: '@tesbo.testId("TES-TC-1305")' },
    async ({ page }) => {
      const button = exportButton(page);
      await expect(button).toBeVisible();
      await expect(button).toBeEnabled();
      // The exact shape of the original defect: a title of "Coming soon" and a not-allowed cursor.
      await expect(button).not.toHaveAttribute("title", "Coming soon");
      expect(await button.evaluate((el) => getComputedStyle(el).cursor)).not.toBe("not-allowed");
      // And nothing anywhere on the screen still advertises an export that isn't built.
      await expect(page.locator('[title="Coming soon"]')).toHaveCount(0);
      await expect(page.getByText("Export PDF")).toHaveCount(0);
    },
  );

  test(
    ticket("REG-RPT-U-02", "10218723531", "the menu offers CSV and Excel, both aimed at the current view"),
    { tag: '@tesbo.testId("TES-TC-1306")' },
    async ({ page }) => {
      await openExportMenu(page);
      await expect(page.getByTestId("reports-export-csv")).toHaveAttribute(
        "href",
        /\/reports\/export\/csv\?view=overview/,
      );
      await expect(page.getByTestId("reports-export-xlsx")).toHaveAttribute(
        "href",
        /\/reports\/export\/xlsx\?view=overview/,
      );
    },
  );

  test(
    ticket("REG-RPT-U-03", "10218723531", "switching tabs switches what gets exported"),
    { tag: '@tesbo.testId("TES-TC-1307")' },
    async ({ page }) => {
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
        await expect(page.getByTestId("reports-export-csv")).toHaveAttribute("href", new RegExp(`view=${view}`));
        // Close it again so the next iteration's click lands on the button, not the open menu.
        await page.keyboard.press("Escape");
        await page.mouse.click(5, 400);
      }
    },
  );

  test(
    ticket("REG-RPT-U-04", "10218723531", "the nav's own export rows point at the same file"),
    { tag: '@tesbo.testId("TES-TC-1308")' },
    async ({ page }) => {
      await expect(page.getByTestId("reports-nav-export-csv")).toHaveAttribute(
        "href",
        /\/reports\/export\/csv\?view=overview/,
      );
      await expect(page.getByTestId("reports-nav-export-xlsx")).toHaveAttribute(
        "href",
        /\/reports\/export\/xlsx\?view=overview/,
      );
    },
  );

  test(
    ticket("REG-RPT-U-05", "10218723531", "the CSV link really serves a file to this session"),
    { tag: '@tesbo.testId("TES-TC-1309")' },
    async ({ page }) => {
      /*
       * Followed with page.request rather than by clicking: the anchor opens in a new tab, and a
       * download that starts inside a popup emits its event on the popup rather than this page, which
       * makes the click-and-wait form flaky for reasons that have nothing to do with the export. Going
       * through page.request keeps the session cookie and still proves the whole path — the href the
       * UI built, the auth on it, the headers, and the first line of the file.
       */
      await openExportMenu(page);
      const href = (await page.getByTestId("reports-export-csv").getAttribute("href")) ?? "";
      expect(href, "the export link has no href, which is the original defect").toBeTruthy();

      const res = await page.request.get(href);
      expect(res.status(), await res.text()).toBe(200);
      expect(res.headers()["content-disposition"]).toContain('filename="report-overview.csv"');
      const body = await res.text();
      expect(body.split("\n")[0]).toBe("section,label,metric,value");
      expect(body.length).toBeGreaterThan("section,label,metric,value".length);
    },
  );
});
