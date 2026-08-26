import fs from "node:fs";
import path from "node:path";
import { expect, request as pwRequest, test } from "@playwright/test";
import { env } from "../utils/env";

const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));
const STATE_PATH = path.join(__dirname, "../.auth/state.json");

test.describe("test case list pagination", () => {
  // Regression test for a bug where the backend sent the real total via an X-Total-Count
  // header that wasn't in the CORS exposedHeaders allowlist. Cross-origin fetch() silently
  // returned null for it, so the frontend fell back to the current page's row count as the
  // "total" — making a full page look like the last page and disabling Next forever.
  test("Next/Previous move between pages and show the correct rows for a suite with 12 test cases", { tag: '@tesbo.testId("TES-TC-835")' }, async ({
    page,
  }) => {
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    const suiteName = `E2E Pagination Suite ${Date.now()}`;
    let suiteId = "";

    try {
      const suite = await (
        await api.post(`/api/projects/${ctx.projectId}/suites`, { data: { name: suiteName } })
      ).json();
      suiteId = suite.id;

      for (let i = 0; i < 12; i++) {
        const createRes = await api.post(`/api/projects/${ctx.projectId}/testcases`, {
          data: { title: `E2E Pagination Case ${Date.now()}-${i}`, suiteId },
        });
        expect(createRes.ok()).toBeTruthy();
      }

      // Ground truth for what each page should show, from the same API the UI calls — this
      // test doesn't assume a sort order, it just checks the UI matches whatever the API says.
      const page1Res = await api.get(`/api/projects/${ctx.projectId}/testcases`, {
        params: { suiteId, limit: 10, offset: 0 },
      });
      expect(page1Res.headers()["x-total-count"]).toBe("12");
      const page1Expected: string[] = (await page1Res.json()).map((tc: { title: string }) => tc.title);
      const page2Res = await api.get(`/api/projects/${ctx.projectId}/testcases`, {
        params: { suiteId, limit: 10, offset: 10 },
      });
      const page2Expected: string[] = (await page2Res.json()).map((tc: { title: string }) => tc.title);
      expect(page1Expected).toHaveLength(10);
      expect(page2Expected).toHaveLength(2);

      await page.goto(`/projects/${ctx.projectId}/testcases?suiteId=${suiteId}`);
      const pagination = page.getByTestId("testcases-pagination");
      await pagination.getByTestId("testcases-page-size").selectOption("10");

      const previousButton = pagination.getByRole("button", { name: "Previous" });
      const nextButton = pagination.getByRole("button", { name: "Next" });

      await expect(pagination).toContainText("12 results");
      await expect(pagination).toContainText("page 1 of 2");
      await expect(previousButton).toBeDisabled();
      await expect(nextButton).toBeEnabled();
      for (const title of page1Expected) {
        await expect(page.getByRole("button", { name: title })).toBeVisible();
      }

      await nextButton.click();

      await expect(pagination).toContainText("page 2 of 2");
      await expect(nextButton).toBeDisabled();
      await expect(previousButton).toBeEnabled();
      for (const title of page2Expected) {
        await expect(page.getByRole("button", { name: title })).toBeVisible();
      }
      // The actual regression: before the fix, totalPages was miscomputed as 1, so this row
      // from page 1 either stayed on screen (Next was a no-op) or Next was disabled outright.
      await expect(page.getByRole("button", { name: page1Expected[0] })).not.toBeVisible();

      await previousButton.click();

      await expect(pagination).toContainText("page 1 of 2");
      await expect(previousButton).toBeDisabled();
      await expect(page.getByRole("button", { name: page1Expected[0] })).toBeVisible();
    } finally {
      if (suiteId) {
        await api.delete(`/api/suites/${suiteId}`, {
          params: { mode: "deleteTestcases" },
          failOnStatusCode: false,
        });
      }
      await api.dispose();
    }
  });
});
