import { expect, request, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { waitForPasswordResetLinkInLogs, backendLogsAvailable } from "../utils/backend-logs";
import { env, testAddress } from "../utils/env";
import {
  FIXTURE_PASSWORD,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  writeStorageState,
  type RbacTenant,
} from "../utils/rbac-tenant";

/*
 * The account screen at /account, and the forgot/reset-password flow that reaches the same stored
 * password from outside a session.
 *
 * Three reported tickets live here:
 *
 *   - BetterBugs 6a840253 — the page's label should read "My Account", not "Account". ACU-01 is
 *     currently RED: app/(app)/account/page.tsx renders `<h1>Account</h1>` and Sidebar.tsx labels
 *     its footer link "Account". Per §3 this is not to be turned green by weakening it — it clears
 *     when the label changes in both places.
 *   - BetterBugs 6a8400e2 — changing a password must confirm it did. Already implemented
 *     (`showToast` after `changePassword`), so ACU-02 is regression cover.
 *   - BetterBugs 6a7b24ef — "Forgot/Reset Password functionality is missing". It exists now, end to
 *     end: a link on /login, POST /password/forgot, an emailed token, /reset-password/:token, and
 *     POST /password/reset. ACU-05..ACU-10 pin the whole path including its refusals.
 *
 * Why its own disposable tenant ("account-ui"): every test below CHANGES a real password. Run
 * against the shared smoke account and the next spec's login — and global-setup's on the following
 * run — would authenticate with a password that no longer exists. The suite also restores
 * FIXTURE_PASSWORD in afterEach so `loginAs()` keeps working for anything that reuses this tenant.
 *
 * The reset link is read out of the backend log, not a mailbox: outside production the backend runs
 * EMAIL_DELIVERY_MODE=log and prints "PASSWORD RESET for <email>: <url>" (EmailService
 * sendPasswordReset keeps that format parseable precisely for this). No real mail is sent.
 *
 * Locator notes: `Field`/`FieldLabel` DO set htmlFor on this screen, so ids are used directly
 * (#current-password, #new-password, #confirm-new-password). The toast is a fixed-position div with
 * no role, so it is matched by its text.
 */

/** Distinct from FIXTURE_PASSWORD, and satisfies validatePasswordValue (upper, lower, digit, 8+). */
const NEW_PASSWORD = "E2E-Account-Next-7k2!";

test.describe("account screen and password reset (UI)", () => {
  let tenant: RbacTenant | null = null;
  let ownerState = "";
  const contexts: BrowserContext[] = [];

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("account-ui");
    if (!tenant) return;
    ownerState = await writeStorageState(tenant.owner, "account-ui-owner");
  });

  test.afterAll(async () => {
    await Promise.all(contexts.map((ctx) => ctx.close()));
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  test.afterEach(async () => {
    // Put the fixture password back however the test left it, so loginAs()/writeStorageState()
    // still work for this tenant — including on the next run against the persistent volume.
    if (!tenant) return;
    await restoreFixturePassword();
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Resets the owner's password to FIXTURE_PASSWORD through the product's own change endpoint.
   *
   * Tries the two passwords a test could have left behind. Deliberately NOT done through psql: the
   * hash format is the password service's business, and a hand-written row would drift from it.
   */
  async function restoreFixturePassword(): Promise<void> {
    for (const candidate of [NEW_PASSWORD, FIXTURE_PASSWORD]) {
      const ctx = await requestContextFor(candidate);
      if (!ctx) continue;
      const res = await ctx.post("/api/auth/password/change", {
        data: { currentPassword: candidate, newPassword: FIXTURE_PASSWORD },
        failOnStatusCode: false,
      });
      await ctx.dispose();
      if (res.ok() || res.status() === 204) return;
    }
  }

  /** A logged-in API context for the owner at a given password, or null if that password is wrong. */
  async function requestContextFor(password: string): Promise<APIRequestContext | null> {
    // storageState cleared explicitly: request.newContext() otherwise inherits account A's session
    // from playwright.config.ts, and the login below would appear to succeed on any password.
    const ctx = await request.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });
    const res = await ctx.post("/api/auth/password/login", {
      data: { email: tenant!.owner.email, password },
      failOnStatusCode: false,
    });
    if (!res.ok()) {
      await ctx.dispose();
      return null;
    }
    return ctx;
  }

  async function openAccount(browser: Browser): Promise<Page> {
    const ctx = await browser.newContext({ storageState: ownerState });
    contexts.push(ctx);
    const page = await ctx.newPage();
    await page.goto("/account");
    await expect(page.getByRole("heading", { level: 2, name: /Change password|Set a password/ })).toBeVisible();
    return page;
  }

  /** A fresh browser with no session, for the signed-out halves of the reset flow. */
  async function anonymousPage(browser: Browser): Promise<Page> {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    contexts.push(ctx);
    return ctx.newPage();
  }

  async function fillChangePassword(page: Page, current: string, next: string, confirm = next) {
    await page.locator("#current-password").fill(current);
    await page.locator("#new-password").fill(next);
    await page.locator("#confirm-new-password").fill(confirm);
    await page.getByRole("button", { name: /Change password|Set password/ }).click();
  }

  /** Proves a password is the live one by using it, rather than trusting a toast. */
  async function passwordWorks(password: string): Promise<boolean> {
    const ctx = await requestContextFor(password);
    if (!ctx) return false;
    await ctx.dispose();
    return true;
  }

  // ─── The label ─────────────────────────────────────────────────────────────

  test('ACU-01 the account screen is labelled "My Account"', async ({ browser }) => {
    const page = await openAccount(browser);

    // Both places the label appears: the page heading and the sidebar link that reaches it.
    await expect(page.getByRole("heading", { level: 1, name: "My Account" })).toBeVisible();
    await expect(page.locator('a[href="/account"]')).toContainText("My Account");
  });

  // ─── Changing a password from the account screen ───────────────────────────

  test("ACU-02 a successful change confirms itself on screen", async ({ browser }) => {
    const page = await openAccount(browser);

    await fillChangePassword(page, FIXTURE_PASSWORD, NEW_PASSWORD);

    await expect(page.getByText(/Password changed/i)).toBeVisible();
    // The toast is not the assertion on its own — the new password has to actually work.
    expect(await passwordWorks(NEW_PASSWORD), "the new password should authenticate").toBe(true);
    expect(await passwordWorks(FIXTURE_PASSWORD), "the old password must stop working").toBe(false);
  });

  test("ACU-03 the form clears itself after a successful change", async ({ browser }) => {
    const page = await openAccount(browser);

    await fillChangePassword(page, FIXTURE_PASSWORD, NEW_PASSWORD);
    await expect(page.getByText(/Password changed/i)).toBeVisible();

    // Leaving the old values in the boxes would offer them to the next shoulder that walks past.
    await expect(page.locator("#current-password")).toHaveValue("");
    await expect(page.locator("#new-password")).toHaveValue("");
    await expect(page.locator("#confirm-new-password")).toHaveValue("");
  });

  test("ACU-04 a wrong current password, a mismatch, and a weak password are each refused", async ({
    browser,
  }) => {
    const page = await openAccount(browser);

    // Wrong current password — refused by the server.
    await fillChangePassword(page, "E2E-Not-The-Password-1x", NEW_PASSWORD);
    await expect(page.getByText(/Password changed/i)).toHaveCount(0);

    // Mismatched confirmation — refused in the page, before any request.
    await page.reload();
    await fillChangePassword(page, FIXTURE_PASSWORD, NEW_PASSWORD, `${NEW_PASSWORD}-different`);
    await expect(page.getByText(/do not match|don't match/i)).toBeVisible();

    // Too weak for validatePasswordValue (no uppercase, no digit, under 8).
    await page.reload();
    await fillChangePassword(page, FIXTURE_PASSWORD, "short");
    // The full error text, not /at least 8 characters/i: PASSWORD_RULES_HINT ("At least 8
    // characters, with an uppercase letter, …") is rendered under the field at all times, so the
    // loose pattern matched the permanent hint as well as the error and strict mode refused both.
    await expect(page.getByText("Password must be at least 8 characters", { exact: true })).toBeVisible();

    // Through all three refusals the stored password is untouched.
    expect(await passwordWorks(FIXTURE_PASSWORD)).toBe(true);
    expect(await passwordWorks(NEW_PASSWORD)).toBe(false);
  });

  // ─── Forgot password ───────────────────────────────────────────────────────

  test("ACU-05 the login screen offers a way to recover a forgotten password", async ({ browser }) => {
    const page = await anonymousPage(browser);
    await page.goto("/login");

    const link = page.getByRole("link", { name: /Forgot password/i });
    await expect(link).toBeVisible();

    await link.click();
    await page.waitForURL(/\/forgot-password$/);
    await expect(page.getByText("Forgot password?")).toBeVisible();
  });

  test("ACU-06 requesting a reset link says so without revealing whether the account exists", async ({
    browser,
  }) => {
    const page = await anonymousPage(browser);
    await page.goto("/forgot-password");

    // A known address and an unknown one must be answered identically — otherwise the screen is an
    // account-existence oracle for anyone who asks, the same reason signup/start answers 204.
    for (const email of [tenant!.owner.email, testAddress("account-no-such-user")]) {
      await page.goto("/forgot-password");
      await page.locator("#email").fill(email);
      await page.getByRole("button", { name: /Send reset link/i }).click();
      await expect(page.getByText("Check your email")).toBeVisible();
      await expect(page.getByText(email, { exact: false })).toBeVisible();
    }
  });

  test("ACU-07 a reset link sets a new password and signs the user in with it", async ({ browser }) => {
    test.skip(!backendLogsAvailable(), "reads the reset link out of the backend container log");
    const page = await anonymousPage(browser);

    await page.goto("/forgot-password");
    await page.locator("#email").fill(tenant!.owner.email);
    await page.getByRole("button", { name: /Send reset link/i }).click();
    await expect(page.getByText("Check your email")).toBeVisible();

    const resetUrl = await waitForPasswordResetLinkInLogs(tenant!.owner.email);
    expect(resetUrl, "the backend should have printed a reset link").toBeTruthy();

    await page.goto(new URL(resetUrl!).pathname);
    await expect(page.getByText("Set a new password")).toBeVisible();
    await page.locator("#password").fill(NEW_PASSWORD);
    await page.locator("#confirmPassword").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: /^Reset password$/i }).click();

    await expect(page.getByText("Password reset")).toBeVisible();
    expect(await passwordWorks(NEW_PASSWORD), "the reset password should authenticate").toBe(true);
    expect(await passwordWorks(FIXTURE_PASSWORD), "the old password must stop working").toBe(false);
  });

  test("ACU-08 a reset link cannot be used twice", async ({ browser }) => {
    test.skip(!backendLogsAvailable(), "reads the reset link out of the backend container log");
    const page = await anonymousPage(browser);

    await page.goto("/forgot-password");
    await page.locator("#email").fill(tenant!.owner.email);
    await page.getByRole("button", { name: /Send reset link/i }).click();
    await expect(page.getByText("Check your email")).toBeVisible();

    const resetUrl = await waitForPasswordResetLinkInLogs(tenant!.owner.email);
    expect(resetUrl).toBeTruthy();
    const resetPath = new URL(resetUrl!).pathname;

    await page.goto(resetPath);
    await page.locator("#password").fill(NEW_PASSWORD);
    await page.locator("#confirmPassword").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: /^Reset password$/i }).click();
    await expect(page.getByText("Password reset")).toBeVisible();

    // Second visit with the same token: the page must report it spent, not offer the form again.
    await page.goto(resetPath);
    await expect(page.getByText("Link expired")).toBeVisible();
    await expect(page.locator("#password")).toHaveCount(0);
  });

  test("ACU-09 an unknown or malformed reset token is reported, never a blank or broken page", async ({
    browser,
  }) => {
    const page = await anonymousPage(browser);

    for (const token of ["not-a-real-token", "0".repeat(64), "../../etc/passwd"]) {
      await page.goto(`/reset-password/${encodeURIComponent(token)}`);
      await expect(page.getByText("Link expired"), `token ${token} should be refused cleanly`).toBeVisible();
      await expect(page.locator("#password")).toHaveCount(0);
    }
  });

  test("ACU-10 the reset form enforces the same password rules as the account screen", async ({ browser }) => {
    test.skip(!backendLogsAvailable(), "reads the reset link out of the backend container log");
    const page = await anonymousPage(browser);

    await page.goto("/forgot-password");
    await page.locator("#email").fill(tenant!.owner.email);
    await page.getByRole("button", { name: /Send reset link/i }).click();
    await expect(page.getByText("Check your email")).toBeVisible();

    const resetUrl = await waitForPasswordResetLinkInLogs(tenant!.owner.email);
    expect(resetUrl).toBeTruthy();
    await page.goto(new URL(resetUrl!).pathname);

    // Too short.
    await page.locator("#password").fill("short");
    await page.locator("#confirmPassword").fill("short");
    await page.getByRole("button", { name: /^Reset password$/i }).click();
    await expect(page.getByText("Password must be at least 8 characters", { exact: true })).toBeVisible();

    // Long enough but no uppercase and no digit.
    await page.locator("#password").fill("alllowercase");
    await page.locator("#confirmPassword").fill("alllowercase");
    await page.getByRole("button", { name: /^Reset password$/i }).click();
    await expect(page.getByText(/uppercase|number/i)).toBeVisible();

    // Mismatched confirmation.
    await page.locator("#password").fill(NEW_PASSWORD);
    await page.locator("#confirmPassword").fill(`${NEW_PASSWORD}-different`);
    await page.getByRole("button", { name: /^Reset password$/i }).click();
    await expect(page.getByText(/do not match|don't match/i)).toBeVisible();

    // None of the refusals changed the stored password.
    expect(await passwordWorks(FIXTURE_PASSWORD)).toBe(true);
  });
  // ─── The profile card ──────────────────────────────────────────────────────

  test("ACU-11 the profile shows the name captured at signup, not just the email", async ({ browser }) => {
    /*
     * Basecamp 10212498688 — "Profile page should have user name and surname and mobile number fields
     * fetched during sign up". The Profile card rendered nothing but the email.
     *
     * The name half was a pure display gap: /signup collects First name and Last name, sends them as
     * one `name`, and GET /me has always returned it — the screen just never read it. Asserted against
     * the value the API reports rather than a hard-coded string, so this stays true for any tenant.
     *
     * The mobile number is deliberately NOT asserted: signup never collects one, there is no column
     * and no value to fetch, so there is nothing to display. That half is a separate feature and is
     * recorded on the card for Specification — not silently rendered as an empty row.
     */
    const page = await openAccount(browser);

    const reported = await page.evaluate(async () => {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      return res.ok ? ((await res.json()) as { name?: string | null; email?: string | null }) : null;
    });
    expect(reported, "GET /me did not answer").not.toBeNull();
    const expectedName = (reported!.name ?? "").trim();
    expect(expectedName, "this tenant's user has no name stored, so the test proves nothing").not.toBe("");

    // The name is on the screen, and labelled — not just present somewhere in the markup.
    const nameValue = page.locator("#account-name");
    await expect(nameValue, "the profile card shows no name field").toBeVisible();
    await expect(nameValue).toHaveText(expectedName);

    // The email it used to show alone is still there.
    await expect(page.locator("#account-email")).toHaveText((reported!.email ?? "").trim());
  });
});
