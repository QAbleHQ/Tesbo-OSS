import { expect, test } from "@playwright/test";
import {
  accountA,
  apiContext,
  cleanup,
  createCycle,
  createPlan,
  modalByTitle,
  ticket,
  unique,
} from "../fixtures";

/*
 * Reported-ticket regression for the test plan's "Link existing run" picker.
 * Card 10221925706, BetterBugs 6a86d18f — "Misleading 'Test Run Is Not Available' Message Displayed
 * After Adding a New Test Run".
 *
 * WHAT THE CARD IS ACTUALLY ABOUT. The plan screen's picker (page.tsx handleOpenAssociate) fetches
 * every run in the project and subtracts the ones already linked to this plan:
 *
 *   const all = await listTestRuns(projectId);
 *   const associatedIds = new Set(runs.map((r) => r.id));
 *   setAllRuns(all.filter((r) => !associatedIds.has(r.id)));
 *
 * and renders "No unlinked test runs available." when that comes back empty. So the message is
 * MISLEADING exactly when the subtraction is wrong — when unlinked runs do exist and the picker
 * still claims none do. That, not the wording, is the testable defect, and it is what these tests
 * pin. The reporter's own path (create a run from the plan, then open the picker) reaches it because
 * the newly created run is linked already, which makes "none available" correct but confusing when
 * it is the only run in the project.
 *
 * Runs are created over the API rather than through the screen's own "Create test run" form on
 * purpose: that form is disabled unless the project has test environments configured
 * (environmentOptions.length === 0 disables the submit), which would couple this ticket's regression
 * to card 10221899361's feature and make a failure here ambiguous.
 */

test.describe("test plan runs — reported tickets", () => {
  test(
    ticket("REG-PLAN-01", "10221925706", "the picker offers an unlinked run instead of claiming there are none"),
    async ({ page }) => {
      const api = await apiContext();
      const projectId = accountA().projectId;

      const plan = await createPlan(api, projectId, { name: unique("Plan") });
      // One run already attached to the plan, one deliberately left loose. The loose one is what the
      // picker must offer; the attached one is what it must not offer twice.
      const linked = await createCycle(api, projectId, { name: unique("Run Linked"), planId: plan.id });
      const unlinked = await createCycle(api, projectId, { name: unique("Run Loose") });

      try {
        await page.goto(`/projects/${projectId}/plans/${plan.id}`);

        await page.getByRole("button", { name: "Link existing run" }).click();

        // Via modalByTitle: components/ui/Modal.tsx sets role="presentation", never "dialog".
        const picker = modalByTitle(page, "Link Existing Test Run");
        await expect(picker).toBeVisible();

        // The claim under test: with a loose run in the project, the empty-state must not appear.
        await expect(
          picker.getByText("No unlinked test runs available."),
          "an unlinked run exists in this project, so the picker must not claim otherwise",
        ).toHaveCount(0);

        await expect(picker.getByText(String(unlinked.name))).toBeVisible();
        await expect(
          picker.getByText(String(linked.name)),
          "a run already linked to this plan must not be offered for linking again",
        ).toHaveCount(0);
      } finally {
        await cleanup(api, [
          `/api/cycles/${unlinked.id}`,
          `/api/cycles/${linked.id}`,
          `/api/plans/${plan.id}`,
        ]);
        await api.dispose();
      }
    },
  );

  test(
    ticket("REG-PLAN-02", "10221925706", "a linked run shows on the plan and is excluded from the picker"),
    async ({ page }) => {
      /*
       * The other direction, and the one that keeps REG-PLAN-01 honest: the message itself is correct
       * behaviour when it is true. A "fix" that simply deleted the empty state would pass REG-PLAN-01
       * and leave the picker rendering an empty list with no explanation.
       *
       * Scoped to a plan whose project has exactly one run, which this test both creates and links,
       * so the assertion does not depend on how many other runs the shared project happens to hold —
       * it asserts on the picker's contents, not on a project-wide count.
       */
      const api = await apiContext();
      const projectId = accountA().projectId;

      const plan = await createPlan(api, projectId, { name: unique("Plan") });
      const linked = await createCycle(api, projectId, { name: unique("Run Only"), planId: plan.id });

      try {
        await page.goto(`/projects/${projectId}/plans/${plan.id}`);

        // The linked run is on the plan's own list — the state the picker's subtraction reads from.
        await expect(page.getByText(String(linked.name)).first()).toBeVisible();

        await page.getByRole("button", { name: "Link existing run" }).click();
        // Via modalByTitle: components/ui/Modal.tsx sets role="presentation", never "dialog".
        const picker = modalByTitle(page, "Link Existing Test Run");
        await expect(picker).toBeVisible();

        await expect(
          picker.getByText(String(linked.name)),
          "the plan's own run must not be offered as something to link",
        ).toHaveCount(0);
      } finally {
        await cleanup(api, [`/api/cycles/${linked.id}`, `/api/plans/${plan.id}`]);
        await api.dispose();
      }
    },
  );
});
