import { expect, test } from "@playwright/test";

test.describe("health", () => {
  test("GET /health reports ok", { tag: '@tesbo.testId("TES-TC-195")' }, async ({ request }) => {
    const res = await request.get("/health");
    expect(res.ok()).toBeTruthy();
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  test("GET /api/health reports ok", { tag: '@tesbo.testId("TES-TC-196")' }, async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.ok()).toBeTruthy();
    expect(await res.json()).toMatchObject({ status: "ok" });
  });
});
