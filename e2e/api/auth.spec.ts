import { expect, test } from "@playwright/test";
import { env } from "../utils/env";

test.describe("auth", () => {
  test("an authenticated session can fetch the current user", async ({ request }) => {
    const res = await request.get("/api/auth/me");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.email).toBe(env.testEmail);
  });

  test("an unauthenticated request is rejected", async ({ playwright }) => {
    // Playwright Test's request.newContext() otherwise inherits the project's default
    // storageState (our logged-in session) — clear it explicitly to get a truly anonymous context.
    const anon = await playwright.request.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });
    const res = await anon.get("/api/auth/me");
    expect(res.status()).toBe(401);
    await anon.dispose();
  });

  test("an incorrect password is rejected", async ({ playwright }) => {
    const anon = await playwright.request.newContext({
      baseURL: env.apiBaseUrl,
      storageState: { cookies: [], origins: [] },
    });
    const res = await anon.post("/api/auth/password/login", {
      data: { email: env.testEmail, password: "definitely-wrong-password" },
      failOnStatusCode: false,
    });
    expect(res.ok()).toBeFalsy();
    await anon.dispose();
  });
});
