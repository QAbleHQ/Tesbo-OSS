import { expect, test, type APIRequestContext } from "@playwright/test";
import { accountA, apiContext, cleanupRun, seedRun, ticket, unique, type SeededRun } from "../fixtures";

/*
 * Reported-ticket regressions for the two aggregate screens — the workspace dashboard at /dashboard
 * and the projects list at /projects.
 *
 *   10226480729 / [workspace Dashboard] need to update labels
 *   10221720616 / [Dashboard] execution progress bar colours are not visible
 *   10221710841 / [Projects] list view not showing failed
 *
 * WHY THESE ARE HERE. ui/project-dashboard.spec.ts and ui/projects-list.spec.ts cover all three, and
 * both are pinned to `.auth/state-screens.json` with `test.skip(!!skipReason)` on every describe.
 * They need the screens tenant — a workspace global-setup puts on Pro through psql so those files
 * can hold several projects alive at once for their list-wide assertions. No database on a deployed
 * environment means no tenant, which means all three cards' cover skips there.
 *
 * WHAT CHANGES IN THE PORT, AND WHY IT IS STILL THE SAME TEST. Those files assert on a workspace
 * they own outright, so they can say "1 failed" and "one bar per status". Account A's workspace is
 * shared and already holds work, so absolute counts are not available here. Every assertion below is
 * therefore written as the invariant the card was actually about — that the failed share is
 * REPRESENTED at all, and that the bars carry DISTINCT, non-transparent colour — which is what was
 * broken in each case. A count of exactly one was never the point; a fail segment that renders as
 * nothing at all was.
 */

test.describe("workspace dashboard — reported tickets", () => {
  let api: APIRequestContext;
  let projectId: string;
  let run: SeededRun | undefined;

  test.beforeAll(async () => {
    api = await apiContext();
    projectId = accountA().projectId;
    // Three different outcomes so the "every bar is the same colour" half of 10221720616 is
    // reachable: with one status present, a single-colour breakdown is correct, not a defect.
    run = await seedRun(api, projectId, {
      statuses: ["Passed", "Failed", "Blocked"],
      status: "Completed",
      name: unique("Dashboard Run"),
    });
  });

  test.afterAll(async () => {
    await cleanupRun(api, projectId, run);
    await api.dispose();
  });

  test(
    ticket("REG-DSH-01", "10226480729", "the workspace dashboard tiles match the vocabulary the rest of the app uses"),
    { tag: '@tesbo.testId("TES-TC-1290")' },
    async ({ page }) => {
      /*
       * The card asked for "Total Suites", "Test Plans" and "Test Runs", and it was right to: the
       * projects list has used "Total Suites" all along, so that is the product's existing vocabulary
       * and the inconsistency the reporter hit. "Cycles" was the real offender either way — internal
       * vocabulary on screen, when every other surface calls them runs.
       */
      await page.goto("/dashboard");
      for (const label of ["Test cases", "Total Suites", "Test plans", "Test runs"]) {
        await expect(page.getByText(label, { exact: true }).first(), `tile "${label}" is missing`).toBeVisible();
      }
      // None of the pre-fix wording survives anywhere on the screen.
      for (const stale of [/^Plans$/, /^Suites$/, /^Cycles$/]) {
        await expect(page.getByText(stale), `stale label ${stale} is still on the dashboard`).toHaveCount(0);
      }
    },
  );

  test(
    ticket("REG-DSH-02", "10221720616", "the workspace execution bars are painted in a visible status colour"),
    { tag: '@tesbo.testId("TES-TC-1291")' },
    async ({ page }) => {
      /*
       * The breakdown painted each bar with the same class it used for the status BADGE — a hardcoded
       * Tailwind 100-level pastel (bg-emerald-100 and friends) on a --surface-tertiary track. The bar
       * was rendered; it simply could not be seen, and in dark mode the pastels did not follow the
       * theme at all. The fill is the solid status dot colour now.
       */
      await page.goto("/dashboard");
      await expect(page.getByText("Execution status")).toBeVisible();

      const fills = page.locator("div.h-2.overflow-hidden.rounded-full > div");
      const count = await fills.count();
      expect(count, "one bar per execution status").toBeGreaterThan(0);

      const colors = await fills.evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
      colors.forEach((background, i) => {
        // A transparent or unset fill is the original defect; so is a bar that inherits the track.
        expect(background, `bar ${i} has no colour of its own`).not.toBe("rgba(0, 0, 0, 0)");
        expect(background, `bar ${i} is transparent`).not.toBe("transparent");
      });

      // The bars must not all be the same colour either — that was the other half of it. The fixture
      // seeds a pass, a fail and a block, so at least two statuses are present by construction.
      expect(new Set(colors).size, `every bar shares one colour: ${colors.join(", ")}`).toBeGreaterThan(1);
    },
  );
});

test.describe("projects list — the list view reports failures", () => {
  let api: APIRequestContext;
  let projectId: string;
  let projectName: string;
  let run: SeededRun | undefined;

  test.beforeAll(async () => {
    api = await apiContext();
    projectId = accountA().projectId;
    const project = await (await api.get(`/api/projects/${projectId}`)).json();
    projectName = project.name;
    // Two passes and one failure: a pass rate that is neither 0 nor 100, so a bar that only ever
    // paints the passing share is visibly wrong rather than coincidentally right.
    run = await seedRun(api, projectId, {
      statuses: ["Passed", "Passed", "Failed"],
      status: "Completed",
      name: unique("Projects List Run"),
    });
  });

  test.afterAll(async () => {
    await cleanupRun(api, projectId, run);
    await api.dispose();
  });

  test(
    ticket("REG-PRJ-01", "10221710841", "a project with failures shows a failed segment and count in the list row"),
    { tag: '@tesbo.testId("TES-TC-1292")' },
    async ({ page }) => {
      /*
       * The grid card has always carried the full breakdown — a segmented bar plus "N passed · N
       * failed". The list row drew a SINGLE GREEN BAR filled to the pass rate, so a project at 67%
       * looked like a third of its work was missing rather than failed.
       *
       * The count is asserted as "some failures, reported" rather than as an exact number: this is
       * account A's shared project, so the workspace-wide failed total is whatever other specs have
       * left behind plus this fixture's one. The defect was that the number and the segment were
       * absent entirely, and that is what is pinned.
       */
      await page.goto("/projects");
      await page.getByRole("button", { name: "List view" }).click();

      const row = page.locator("a").filter({ hasText: projectName }).first();
      await expect(row).toBeVisible();

      // The failure count has to be readable without opening the project.
      const failedText = row.getByText(/\d+ failed/);
      await expect(failedText).toBeVisible();
      const failed = Number((await failedText.textContent())?.match(/(\d+) failed/)?.[1]);
      expect(failed, "the fixture put a failure in this project, so the row cannot report zero").toBeGreaterThanOrEqual(1);

      // And the bar itself carries a fail-coloured segment, not just green. The compact bar keeps its
      // counts in a title attribute because the row has no space for a legend, so it is also the
      // thing that identifies the bar among the row's other flex children.
      const bar = row.locator("div[title]").filter({ hasText: "" }).first();
      await expect(bar).toBeVisible();
      const tooltip = await bar.getAttribute("title");
      expect(tooltip, "the compact bar should name its counts in a tooltip").toMatch(/\d+ passed · \d+ failed/);

      const colors = await bar.locator("> div").evaluateAll((els) =>
        els.map((el) => getComputedStyle(el).backgroundColor),
      );
      expect(colors.length, "the compact bar should paint one segment per outcome").toBeGreaterThanOrEqual(2);
      expect(new Set(colors).size, "passed and failed must not be the same colour").toBeGreaterThan(1);
    },
  );
});
