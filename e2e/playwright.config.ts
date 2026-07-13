import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { env } from "./utils/env";

export default defineConfig({
  testDir: __dirname,
  testMatch: /(api|ui)\/.*\.spec\.ts/,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: env.ci ? 1 : 0,
  reporter: env.ci ? [["list"], ["html", { open: "never" }]] : "list",
  globalSetup: require.resolve("./global-setup"),
  use: {
    storageState: path.join(__dirname, ".auth/state.json"),
  },
  projects: [
    {
      name: "api",
      testMatch: /api\/.*\.spec\.ts/,
      use: { baseURL: env.apiBaseUrl },
    },
    {
      name: "ui",
      testMatch: /ui\/.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: env.webBaseUrl,
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
      },
    },
  ],
});
