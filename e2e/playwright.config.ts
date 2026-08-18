import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { env } from "./utils/env";

export default defineConfig({
  testDir: __dirname,
  testMatch: /(api|ui)\/.*\.spec\.ts/,
  /*
   * 30s was right when the stack's database was the compose postgres container. It is not right for
   * a stack pointed at a hosted Postgres: a single round trip costs tens of milliseconds instead of
   * a fraction of one, and provisionRbacTenant — which creates an org, three users, two projects and
   * their memberships before a suite can start — measures ~57s against this stack's Neon instance.
   * That overran the 30s budget in the `beforeAll` of all 22 suites that own a tenant, so they
   * failed to start rather than failing an assertion.
   *
   * This is the harness's setup budget, not a product-timing assertion, and no assertion below is
   * relaxed by it. Where the product's own speed is the thing under test, the bound is written into
   * the test and left tight — see execution-ops.spec.ts EXO-E-01, which still holds a 250-case add
   * to 30s because that is the ceiling the 524 came from.
   */
  timeout: 120_000,
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
