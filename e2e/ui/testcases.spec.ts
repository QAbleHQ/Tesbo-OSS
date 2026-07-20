import fs from "node:fs";
import path from "node:path";
import { expect, request as pwRequest, test } from "@playwright/test";
import { env } from "../utils/env";

const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));
const STATE_PATH = path.join(__dirname, "../.auth/state.json");

test.describe("test case creation", () => {
  test("a user can create a test case from the UI and see it in the list", async ({ page }) => {
    const title = `UI smoke test case ${Date.now()}`;

    await page.goto(`/projects/${ctx.projectId}/testcases`);
    // Both the toolbar and the empty-state block render a "+ Add test case" button when the
    // project has no test cases yet; either one opens the same create panel.
    await page.getByRole("button", { name: "+ Add test case" }).first().click();

    const panel = page.locator("aside");
    await panel.getByPlaceholder("Describe what this test case validates").fill(title);
    await panel.getByRole("button", { name: "Create", exact: true }).click();

    await expect(panel.getByText("Test case created successfully.")).toBeVisible();
    // A separate full-screen backdrop button shares the same "Close panel" aria-label —
    // scope to the panel itself to hit its dedicated close button.
    await panel.getByRole("button", { name: "Close panel" }).click();
    await expect(page.getByRole("button", { name: title })).toBeVisible();

    // Clean up via the API so repeat runs don't accumulate test cases in the smoke project.
    const api = await pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
    try {
      const listRes = await api.get(`/api/projects/${ctx.projectId}/testcases`, {
        params: { search: title },
      });
      const list = await listRes.json();
      const match = list.find((tc: { id: string; title: string }) => tc.title === title);
      if (match) await api.delete(`/api/projects/${ctx.projectId}/testcases/${match.id}`);
    } finally {
      await api.dispose();
    }
  });
});
