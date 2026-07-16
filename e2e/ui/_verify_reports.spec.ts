import path from "node:path";
import fs from "node:fs";
import { expect, request as pwRequest, test } from "@playwright/test";
import { env } from "../utils/env";

const STATE_PATH = path.join(__dirname, "../.auth/state.json");
const CONTEXT_PATH = path.join(__dirname, "../.auth/context.json");
const SHOT_DIR = path.join(__dirname, "../.auth/_verify_shots");

function apiContext() {
  return pwRequest.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
}

test("re-screenshot every Reports & Insights tab after donut fix", async ({ page }) => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const ctx = JSON.parse(fs.readFileSync(CONTEXT_PATH, "utf-8"));
  const projectId: string = ctx.projectId;

  await page.goto(`/projects/${projectId}/reports`);
  await page.waitForSelector("text=Reports & Insights", { timeout: 15000 });

  const errors: string[] = [];
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
  page.on("pageerror", (err) => errors.push(String(err)));

  const tabs = [
    { label: "Overview", name: "01-overview" },
    { label: "Execution Report", name: "02-execution" },
    { label: "Traceability", name: "03-traceability" },
    { label: "Repository", name: "04-repository" },
    { label: "AI Insights", name: "05-insights" },
    { label: "Trends", name: "06-trends" },
  ];

  for (const tab of tabs) {
    await page.getByText(tab.label, { exact: true }).first().click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(SHOT_DIR, `${tab.name}.png`), fullPage: true });
  }

  fs.writeFileSync(path.join(SHOT_DIR, "console-errors.json"), JSON.stringify(errors, null, 2));
  expect(true).toBe(true);
});
