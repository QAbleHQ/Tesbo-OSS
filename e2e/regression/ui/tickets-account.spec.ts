import { expect, test } from "@playwright/test";
import { alerts, apiContext, ticket } from "../fixtures";

/*
 * Reported-ticket regressions for the My Account screen.
 *
 * SAFETY: not one test here completes a password change. That is a hard constraint, not tidiness —
 * account A's password is what global-setup logs in with, and .auth/state.json is shared by every
 * spec in the run, so a successful change would sign out every concurrent worker and then break the
 * NEXT run's global setup too. ui/account.spec.ts pays for a tenant of its own precisely so it can
 * change passwords; this folder cannot (no database access), so it stays on the rejection paths.
 *
 * That happens to be exactly what card 10230839912 is about: where the REJECTION message is drawn.
 * Every assertion below is reached by submitting input the product must refuse, which leaves the
 * stored password untouched by construction.
 */

test.describe("My Account — reported tickets", () => {
  test(
    ticket("REG-ACC-01", "10230839912", "a mismatched confirmation is reported next to the field it concerns"),
    async ({ page }) => {
      /*
       * EXPECTED RED. app/(app)/account/page.tsx holds ONE `error` string for the whole form and
       * renders it in one place — `{error && <FieldError>{error}</FieldError>}` sitting after all
       * three Field groups, as a direct child of the <form>. So every message, whichever field
       * caused it, appears at the bottom of the page. That is the reported defect verbatim.
       *
       * BetterBugs 6a856ce1 adds "fix this in all pages", which makes this a pattern to be applied
       * across the forms rather than a single-screen change. This test pins the screen the card was
       * filed against; REG-AUTH-01/02 pin the signup and login forms named in the sibling card.
       */
      test.fail();

      await page.goto("/account");

      await page.locator("#new-password").fill("Str0ng-Enough!2026");
      await page.locator("#confirm-new-password").fill("Str0ng-Enough!2027");
      await page.getByRole("button", { name: /Change password|Set password/ }).click();

      // The message itself must appear — that part already works. Via alerts() rather than
      // getByRole("alert"): Next's route announcer carries that role on every page, so the bare
      // query matches two elements and fails strict mode before reaching the real assertion.
      await expect(alerts(page)).toContainText(/do not match/i);

      /*
       * And it must live inside the confirmation field's own group. `Field` is a plain div wrapper
       * (components/ui/Field.tsx), so "next to the field" is expressible as DOM containment: of all
       * the divs that contain #confirm-new-password, the innermost — .last(), since ancestors
       * precede descendants in document order — is that field's group. Today the alert is outside
       * every one of them, which is what makes it render at the end of the page.
       */
      const confirmGroup = page
        .locator("div")
        .filter({ has: page.locator("#confirm-new-password") })
        .last();

      await expect(
        confirmGroup.getByRole("alert"),
        "the mismatch message should sit inside the confirm-password field group, not at the foot of the form",
      ).toBeVisible();
    },
  );

  test(
    ticket("REG-ACC-02", "10230839912", "a rejected password change leaves the stored password usable"),
    async ({ page }) => {
      /*
       * The invariant that makes REG-ACC-01 safe to run at all, asserted rather than assumed.
       *
       * If a validation failure ever started writing the new password anyway, REG-ACC-01 would
       * silently rotate account A's credentials and the damage would show up as unrelated auth
       * failures across the whole suite. Cheap to pin, and it is a real behaviour worth pinning.
       */
      await page.goto("/account");

      await page.locator("#new-password").fill("short");
      await page.locator("#confirm-new-password").fill("short");
      await page.getByRole("button", { name: /Change password|Set password/ }).click();

      await expect(alerts(page)).toBeVisible();

      // The session cookie this context carries is the shared one. Still authenticated means the
      // rejection changed nothing. Asked over a context aimed at the API origin — the `request`
      // fixture in the ui project is pointed at the web origin.
      const api = await apiContext();
      try {
        const me = await api.get("/api/auth/me");
        expect(me.ok(), "a rejected password change must not have invalidated the session").toBeTruthy();
      } finally {
        await api.dispose();
      }
    },
  );
});
