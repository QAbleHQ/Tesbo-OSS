import { expect, test } from "@playwright/test";
import { alerts, ticket } from "../fixtures";

/*
 * Reported-ticket regressions for the unauthenticated signup and login forms.
 *
 * These are the only specs in this folder that must run WITHOUT a session: /signup and /login
 * redirect an authenticated visitor into the app, so account A's cookie would take the browser
 * somewhere else entirely and the assertions would fail for a reason that has nothing to do with the
 * ticket. test.use({ storageState: … }) drops it for this file only.
 *
 * Nothing here submits a signup. That is deliberate: /api/auth/signup/start is IP rate-limited with
 * OTP_MAX_ATTEMPTS of 5, shared across every tenant provisioned in the run, and
 * docs/e2e-coverage-waves.md §6b records that budget as very nearly spent. A test that spends one to
 * assert where a label is drawn is a test that makes another file flaky. Client-side validation is
 * reached by submitting an empty or malformed form, which the frontend refuses before any request.
 */

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("signup and login forms — reported tickets", () => {
  test(
    ticket("REG-AUTH-01", "10230858713", "required fields on the signup form are marked as required"),
    { tag: '@tesbo.testId("TES-TC-1273")' },
    async ({ page }) => {
      /*
       * EXPECTED RED. app/signup/page.tsx renders each FieldLabel as bare text — "First name",
       * "Work email", "Password" — with no asterisk and no `required` attribute on the inputs. So
       * there is nothing, visually or in the accessibility tree, that distinguishes a mandatory
       * field from an optional one.
       *
       * Asserted two ways on purpose. A sighted user needs the visible marker the card asks for; a
       * screen-reader user needs the programmatic one. Either alone would let a "fix" satisfy the
       * test while leaving half the users no better off, so this accepts EITHER for each field but
       * demands that at least one is present.
       */
      test.fail();

      await page.goto("/signup");

      const required = [
        { id: "signup-first-name", label: "First name" },
        { id: "signup-email", label: "Work email" },
        { id: "signup-password", label: "Password" },
      ];

      // Scoped to the credentials form. /signup renders three forms (password, code, OTP) and the
      // BetterBugs widget injects inputs of its own, so a bare id selector is not unique.
      const form = page.locator("form:has(#signup-password)");

      for (const field of required) {
        const input = form.locator(`#${field.id}`);
        await expect(input, `${field.label} should be on the signup form`).toBeVisible();

        const marked = await input.evaluate((el) => {
          const control = el as HTMLInputElement;
          // Programmatic: the input itself says it is required.
          if (control.required || control.getAttribute("aria-required") === "true") return true;
          // Visible: the label for this control carries an asterisk.
          const label = control.id
            ? document.querySelector(`label[for="${control.id}"]`)
            : control.closest("label");
          return !!label?.textContent?.includes("*");
        });

        expect(
          marked,
          `"${field.label}" is mandatory but is marked neither with an asterisk nor as required`,
        ).toBe(true);
      }
    },
  );

  test(
    ticket("REG-AUTH-02", "10230858713", "required fields on the login form are marked as required"),
    { tag: '@tesbo.testId("TES-TC-1274")' },
    async ({ page }) => {
      // EXPECTED RED, same defect on the other form the card names. app/login/page.tsx labels
      // "Email" and "Password" the same bare way.
      test.fail();

      await page.goto("/login");

      /*
       * Scoped to the login form, and it has to be. The BetterBugs widget mounted on this page
       * renders its own <input id="email">, so the document contains TWO elements with that id —
       * invalid HTML, and enough to break `label[for=…]` association as well as any #email selector.
       * That is a real (if third-party) defect on the page; it is not this ticket's, so it is worked
       * around here and reported separately rather than asserted on.
       */
      const form = page.locator("form:has(#password)");

      for (const field of [
        { id: "email", label: "Email" },
        { id: "password", label: "Password" },
      ]) {
        const input = form.locator(`#${field.id}`);
        await expect(input, `${field.label} should be on the login form`).toBeVisible();

        const marked = await input.evaluate((el) => {
          const control = el as HTMLInputElement;
          if (control.required || control.getAttribute("aria-required") === "true") return true;
          const label = control.id
            ? document.querySelector(`label[for="${control.id}"]`)
            : control.closest("label");
          return !!label?.textContent?.includes("*");
        });

        expect(
          marked,
          `"${field.label}" is mandatory but is marked neither with an asterisk nor as required`,
        ).toBe(true);
      }
    },
  );

  test(
    ticket("REG-AUTH-03", "10230858713", "a rejected login reports the problem without leaving the form"),
    { tag: '@tesbo.testId("TES-TC-1275")' },
    async ({ page }) => {
      /*
       * The second half of BetterBugs 6a7d6f64 — "inline validations should be available below
       * field" — on the path that costs nothing to exercise: a malformed email never leaves the
       * browser, so no rate-limit budget is spent and no login attempt is recorded.
       *
       * This one is NOT marked expected-red. The login form does surface a message; what the sibling
       * card disputes is placement, which REG-ACC-01 pins on the screen the reporter filed it
       * against. Here the point is only that submitting bad input is refused visibly and in place,
       * rather than clearing the form or navigating away — the failure mode that would make the
       * placement question moot.
       */
      await page.goto("/login");

      const form = page.locator("form:has(#password)");
      await form.locator("#email").fill("not-an-email");
      await form.locator("#password").fill("whatever");
      await page.getByRole("button", { name: /^(Sign in|Log in|Continue)$/i }).click();

      // Still on the login form, with the typed email preserved and something said about it.
      await expect(page).toHaveURL(/\/login/);
      await expect(form.locator("#email")).toHaveValue("not-an-email");
      /*
       * Either shape counts as "reported": an in-page alert the form rendered itself, or the browser's
       * own constraint validation marking the field invalid and refusing to submit. Which one applies
       * depends on whether the input is type=email, and that is not what this ticket is about.
       */
      await expect(
        alerts(page).or(form.locator("#email:invalid")).first(),
      ).toBeVisible();
    },
  );
});
