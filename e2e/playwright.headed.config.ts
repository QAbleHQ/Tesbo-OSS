import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

/**
 * Debug/demo variant of the main config — run it with `--config playwright.headed.config.ts`.
 *
 * Kept as a separate file rather than folded into playwright.config.ts because everything here is
 * deliberately expensive: a visible browser, and a video + trace + screenshot retained for EVERY
 * test rather than only the failures. That is what makes a green run reviewable after the fact,
 * but it costs disk and wall-clock, so the default config stays lean.
 */
export default defineConfig({
  ...base,
  use: {
    ...base.use,
    headless: false,
    trace: "on",
    video: "on",
    screenshot: "on",
  },
  // Videos are only recorded for projects that launch a browser, so the api project silently
  // ignores `video` — its traces still capture every call made through the `request` fixture.
  projects: base.projects?.map((project) => ({
    ...project,
    use: { ...project.use, headless: false, trace: "on", video: "on", screenshot: "on" },
  })),
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
});
