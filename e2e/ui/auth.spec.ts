import { expect, test } from "@playwright/test";
import { env } from "../utils/env";
import { clearOtpIpRateLimit, clearOtpRateLimit, disposableEmail, seedOtpCode } from "../utils/otp";

test.describe("login", () => {
  // Start these tests logged out even though the project default carries an
  // authenticated storage state, since this suite exercises the login form itself.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a user can sign in with the seeded smoke-test account", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill(env.testEmail);
    await page.getByLabel("Password", { exact: true }).fill(env.testPassword);
    await page.getByRole("button", { name: "Sign in" }).click();

    await page.waitForURL(/\/projects/);
    await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  });

  test("rejects an incorrect password", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill(env.testEmail);
    await page.getByLabel("Password", { exact: true }).fill("definitely-wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.locator("p[role=\"alert\"]")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("rejects an unregistered email", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill(disposableEmail("no-such-user"));
    await page.getByLabel("Password", { exact: true }).fill("whatever-password-123");
    await page.getByRole("button", { name: "Sign in" }).click();

    // Same generic error as a wrong password — the API must not reveal whether the
    // email is registered.
    await expect(page.locator("p[role=\"alert\"]")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("requires an email before submitting", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Password", { exact: true }).fill(env.testPassword);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.locator("p[role=\"alert\"]")).toHaveText("Email is required");
    await expect(page).toHaveURL(/\/login/);
  });

  test("requires a password before submitting", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill(env.testEmail);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.locator("p[role=\"alert\"]")).toHaveText("Password is required");
    await expect(page).toHaveURL(/\/login/);
  });

  test("switching to Email code mode hides the password field", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

    await page.getByRole("button", { name: "Email code" }).click();
    await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send login code" })).toBeVisible();

    await page.getByRole("button", { name: "Password" }).click();
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });
});

test.describe("otp login", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  // Every test here calls the real /otp/request endpoint at least once, and they all
  // share one IP as far as the backend's rate limiter is concerned (all requests come
  // from this same host). Reset before each test so no test starts against a budget
  // partially spent by an earlier one. (IP-scoped only — a blanket clear would race with
  // the API suite's own rate-limit test running concurrently in another project.)
  test.beforeEach(() => clearOtpIpRateLimit());

  async function requestOtpCode(page: import("@playwright/test").Page, email: string) {
    await page.goto("/login");
    await page.getByRole("button", { name: "Email code" }).click();
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByRole("button", { name: "Send login code" }).click();
    await page.waitForURL(/\/verify-otp/);
  }

  async function fillOtpCode(page: import("@playwright/test").Page, code: string) {
    const boxes = page.locator('input[inputmode="numeric"]');
    for (let i = 0; i < code.length; i++) {
      await boxes.nth(i).fill(code[i]);
    }
  }

  test("requesting a code shows the check-your-email screen", async ({ page }) => {
    const email = disposableEmail("otp-request");
    await requestOtpCode(page, email);

    await expect(page.getByText(email)).toBeVisible();
    await expect(page.getByRole("button", { name: "Verify and sign in" })).toBeVisible();
  });

  test("rejects an incorrect code", async ({ page }) => {
    const email = disposableEmail("otp-wrong");
    await requestOtpCode(page, email);

    await fillOtpCode(page, "000000");
    await page.getByRole("button", { name: "Verify and sign in" }).click();

    await expect(page.locator("p[role=\"alert\"]")).toBeVisible();
    await expect(page).toHaveURL(/\/verify-otp/);
  });

  test("rejects an expired code", async ({ page }) => {
    const email = disposableEmail("otp-expired");
    await requestOtpCode(page, email);
    seedOtpCode(email, "111222", -5);

    await fillOtpCode(page, "111222");
    await page.getByRole("button", { name: "Verify and sign in" }).click();

    await expect(page.locator("p[role=\"alert\"]")).toBeVisible();
    await expect(page).toHaveURL(/\/verify-otp/);
  });

  test("signs in an existing user with a valid one-time code", async ({ page }) => {
    // Unlike the disposable emails above, env.testEmail is reused across every run of
    // this suite, so its own rate-limit counter needs an explicit reset too.
    clearOtpRateLimit(env.testEmail);
    await requestOtpCode(page, env.testEmail);
    seedOtpCode(env.testEmail, "654321");

    await fillOtpCode(page, "654321");
    await page.getByRole("button", { name: "Verify and sign in" }).click();

    await page.waitForURL(/\/projects/);
    await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  });

  test("auto-creates an account for a brand-new email", async ({ page }) => {
    const email = disposableEmail("otp-new-account");
    await requestOtpCode(page, email);
    seedOtpCode(email, "789789");

    await fillOtpCode(page, "789789");
    await page.getByRole("button", { name: "Verify and sign in" }).click();

    await page.waitForURL(/\/onboarding/);
    await expect(page.getByRole("heading", { name: "Create your workspace" })).toBeVisible();
  });

  test("lets the user go back to a different email", async ({ page }) => {
    const email = disposableEmail("otp-back");
    await requestOtpCode(page, email);

    await page.getByRole("link", { name: "Use a different email" }).click();
    await expect(page).toHaveURL(/\/login/);
  });
});
