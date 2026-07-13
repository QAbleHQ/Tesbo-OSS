import { expect, test } from "@playwright/test";
import { env } from "../utils/env";

test.describe("login", () => {
  // Start these tests logged out even though the project default carries an
  // authenticated storage state, since this suite exercises the login form itself.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a user can sign in with the seeded smoke-test account", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(env.testEmail);
    await page.getByLabel("Password").fill(env.testPassword);
    await page.getByRole("button", { name: "Sign in" }).click();

    await page.waitForURL(/\/projects/);
    await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  });

  test("rejects an incorrect password", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(env.testEmail);
    await page.getByLabel("Password").fill("definitely-wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });
});
