import { expect, test } from "@playwright/test";
import { ticket } from "../fixtures";

/*
 * Reported-ticket regressions for the application shell — the sidebar, the top bar, and logging out.
 *
 * Runs anywhere: no database, no disposable tenant, nothing but account A's session and the two base
 * URLs. See ../fixtures.ts for why that constraint applies to this whole folder.
 *
 * Three of the tests here are marked test.fail(). That is not a hedge — each one has been checked
 * against the product code on every branch (BugFixes, dev, main) and the behaviour the card asks for
 * is implemented nowhere. The card sits in the board's "Ready For the QA" column regardless. The
 * convention for that in this suite is api/authorization.spec.ts's: assert the behaviour that OUGHT
 * to hold and mark it expected-to-fail, so the test is written once and Playwright reports
 * "unexpectedly passing" the moment the fix lands. Removing the test.fail() is then the whole of the
 * follow-up work. Deleting or weakening these instead would convert a known gap into silent debt.
 */

test.describe("app shell — reported tickets", () => {
  test(
    ticket("REG-SHELL-01", "10230849105", "logging out asks for confirmation before ending the session"),
    { tag: '@tesbo.testId("TES-TC-1269")' },
    async ({ page }) => {
      /*
       * EXPECTED RED. Sidebar.tsx wires the button straight to onLogout() — there is no dialog on
       * any branch. Card 10230849105 asks for a Yes/No confirmation.
       *
       * BetterBugs 6a7da6df also asks for the label to be spelled "Logout". The product says
       * "Log out", which is the correct English spelling of the verb, so that half is a wording
       * preference for the product owner rather than a defect, and is deliberately not asserted here.
       */
      test.fail();

      await page.goto("/projects");

      /*
       * The logout request is intercepted and aborted, so the session cookie is never invalidated.
       * This matters more than it looks: the cookie in .auth/state.json is shared by every spec in
       * the run, and auth.service.ts's logout() calls invalidateSession(), which revokes it
       * server-side. A real logout here would sign out every other worker mid-assertion.
       * ui/navigation.spec.ts NAV-B-07 established this pattern; NAV-B-06 pays for a disposable user
       * instead, which this folder cannot do without database access.
       *
       * Matched by predicate rather than glob: the frontend posts to the API origin while the page
       * is on the web origin, and a relative glob would be resolved against baseURL and never match.
       */
      let logoutCalls = 0;
      await page.route(
        (url) => url.pathname === "/api/auth/logout",
        (route) => {
          logoutCalls += 1;
          return route.abort("failed");
        },
      );

      await page.getByRole("button", { name: "Log out" }).click();

      // The confirmation is the point: clicking must ASK, not act. A dialog offering an affirmative
      // and a cancel, and — the assertion that actually has teeth — no logout request sent yet.
      // getByRole("dialog") would find nothing even once a dialog exists — Modal.tsx uses
      // role="presentation". Matched on content instead, so this passes the moment a real
      // confirmation appears however it is built.
      const confirmation = page.locator('div[role="presentation"], [role="dialog"], [role="alertdialog"]').last();
      await expect(confirmation).toBeVisible();
      await expect(confirmation.getByRole("button", { name: /^(Yes|Confirm|Log ?out)$/i })).toBeVisible();
      await expect(confirmation.getByRole("button", { name: /^(No|Cancel)$/i })).toBeVisible();
      expect(logoutCalls, "clicking Log out must not end the session before it is confirmed").toBe(0);
    },
  );

  test(
    ticket("REG-SHELL-02", "10230848426", "the project search box offers a control to clear what was typed"),
    { tag: '@tesbo.testId("TES-TC-1270")' },
    async ({ page }) => {
      /*
       * EXPECTED RED. TopBar.tsx renders the ⌘K hint only while the box is empty and puts nothing in
       * its place once text is present — there is no clear affordance on any branch.
       */
      test.fail();

      await page.goto("/projects");

      const search = page.getByPlaceholder("Search projects…");
      await search.fill("regression probe");

      // Any of the shapes a clear control is normally built as. Deliberately broad: the ticket asks
      // for the affordance, not for a particular implementation of it.
      const clear = page
        .getByRole("button", { name: /clear|reset/i })
        .or(page.locator('button[aria-label*="lear" i]'));
      await expect(clear.first()).toBeVisible();

      await clear.first().click();
      await expect(search).toHaveValue("");
    },
  );

  test(
    ticket("REG-SHELL-03", "10230848426", "the search shortcut works on a non-Mac keyboard"),
    { tag: '@tesbo.testId("TES-TC-1271")' },
    async ({ page }) => {
      /*
       * The other half of card 10230848426, and this half is GREEN — worth pinning precisely because
       * the card's claim is wrong. TopBar.tsx line 49 tests `(e.metaKey || e.ctrlKey)`, so Ctrl+K
       * has always focused the box on Windows and Linux. What the reporter actually saw is the HINT
       * reading "⌘K" on a Windows machine, which is a labelling problem, not a broken shortcut.
       *
       * Asserting the working half stops a future "fix" from removing Ctrl+K while relabelling.
       */
      await page.goto("/projects");

      const search = page.getByPlaceholder("Search projects…");
      await expect(search).not.toBeFocused();

      await page.keyboard.press("Control+k");

      await expect(search).toBeFocused();
    },
  );

  test(
    ticket("REG-SHELL-04", "10230846264", "moving between sidebar sections never blanks the app shell"),
    { tag: '@tesbo.testId("TES-TC-1272")' },
    async ({ page }) => {
      /*
       * Card 10230846264 reports a blank "Loading..." screen for 2–3 seconds when switching sidebar
       * items. The duration itself is not a stable assertion — it is a function of whatever machine
       * and network the run happens to get, and pinning a stopwatch to it would produce a test that
       * fails for reasons that have nothing to do with the defect.
       *
       * What IS stable, and is what the reporter actually saw, is the shell being REPLACED: the
       * whole page becoming a bare "Loading..." string with no navigation on it. So this asserts
       * that the sidebar survives the transition and the destination renders, which is precisely
       * the difference between a scoped loading state and a blank screen.
       */
      await page.goto("/projects");

      const sidebar = page.getByRole("navigation").first();
      await expect(sidebar).toBeVisible();

      for (const section of ["Activity", "Projects"]) {
        await sidebar.getByRole("link", { name: section, exact: true }).click();

        // Checked without waiting: the assertion is about the frame immediately after the click,
        // which is when the reported blanking happened.
        await expect(sidebar, `the sidebar disappeared while opening ${section}`).toBeVisible();
        await expect(
          page.getByText("Loading...", { exact: true }),
          `${section} showed a bare "Loading..." screen instead of an in-place loading state`,
        ).toHaveCount(0);

        await expect(page).toHaveURL(new RegExp(section.toLowerCase()));
      }
    },
  );
});
