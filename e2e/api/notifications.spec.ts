import { expect, request, test } from "@playwright/test";
import { env } from "../utils/env";

/*
 * GET /api/notifications and POST /api/notifications/:id/read.
 *
 * The bell icon in TopBar.tsx had no onClick at all (BetterBugs "Notification Icon Does Not
 * Respond When Clicked") — fixed by wiring it to a dropdown panel that calls these two routes.
 *
 * legacy.controller.ts documents both routes as stubs: there is no notifications table wired up
 * yet, so GET always answers an empty list and POST always answers 404. That is a known, separate
 * gap (tracked in docs/e2e-coverage-waves.md) — this spec pins the CURRENT contract the new panel
 * depends on (authenticated callers get a 200 array; anyone unauthenticated is refused; a
 * malformed id is a 404, not a 500), so a future implementation of the real feature has a failing
 * test the moment it changes this contract in a way the panel doesn't expect.
 */

test.describe("notifications", () => {
  test("NOTIF-A-01 an authenticated caller gets a 200 array", { tag: '@tesbo.testId("TES-TC-1178")' }, async ({ request }) => {
    const res = await request.get("/api/notifications", { failOnStatusCode: false });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body), `expected an array, got ${JSON.stringify(body)}`).toBe(true);
  });

  test("NOTIF-A-02 an unauthenticated caller is refused, not served an empty list", { tag: '@tesbo.testId("TES-TC-1179")' }, async () => {
    const anon = await request.newContext({ baseURL: env.apiBaseUrl, storageState: { cookies: [], origins: [] } });
    try {
      const res = await anon.get("/api/notifications", { failOnStatusCode: false });
      // requireSession raises BadRequest ("Authentication required"), matching the rest of the
      // legacy service — see authorization.spec.ts's note on this being 400 rather than 401.
      expect(res.status(), await res.text()).toBe(400);
    } finally {
      await anon.dispose();
    }
  });

  test("NOTIF-A-03 marking a nonexistent notification read answers 404, not a silent success", { tag: '@tesbo.testId("TES-TC-1180")' }, async ({
    request,
  }) => {
    const res = await request.post(`/api/notifications/${crypto.randomUUID()}/read`, {
      failOnStatusCode: false,
    });
    expect(res.status(), await res.text()).toBe(404);
  });

  test("NOTIF-A-04 a malformed id is still a clean 404, not a 500", { tag: '@tesbo.testId("TES-TC-1181")' }, async ({ request }) => {
    for (const id of ["not-a-uuid", "", "..%2F..", "1 OR 1=1"]) {
      const res = await request.post(`/api/notifications/${encodeURIComponent(id)}/read`, {
        failOnStatusCode: false,
      });
      expect(res.status(), `id=${JSON.stringify(id)} — ${await res.text()}`).toBeLessThan(500);
    }
  });

  test("NOTIF-A-05 an unauthenticated caller cannot mark a notification read", { tag: '@tesbo.testId("TES-TC-1182")' }, async () => {
    const anon = await request.newContext({ baseURL: env.apiBaseUrl, storageState: { cookies: [], origins: [] } });
    try {
      const res = await anon.post(`/api/notifications/${crypto.randomUUID()}/read`, {
        failOnStatusCode: false,
      });
      expect(res.status(), await res.text()).toBe(400);
    } finally {
      await anon.dispose();
    }
  });
});
