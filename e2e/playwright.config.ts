import path from "node:path";
import { defineConfig, devices, type ReporterDescription } from "@playwright/test";
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
  /*
   * This suite reports its own results back into Tesbo — the product it tests.
   *
   * baseUrl and projectId live here rather than in the environment on purpose: neither is a secret,
   * and a self-hosted install has to carry its own API host in version control anyway. The
   * credential does not — TESBO_API_TOKEN is read from the environment and never committed.
   *
   * baseUrl is the **API** host (:1021 for this stack, not the frontend's :1020). Pointing it at the
   * web app fails silently: every ingest call 404s, the reporter logs rather than throws, and the
   * run stays green with nothing recorded.
   *
   * With none of the three values set the reporter warns once and stays out of the way, so a
   * checkout with no token still runs an ordinary suite. Setting *some* of them is a hard failure at
   * collection time, because a run that quietly reported nothing looks exactly like one that
   * succeeded.
   */
  reporter: [
    ["list"],
    ...(env.ci ? [["html", { open: "never" }] as ReporterDescription] : []),
    [
      "@tesbox/playwright-reporter",
      {
        baseUrl: "http://localhost:1021",
        projectId: "41dba2a2-a60b-4917-8d63-9f8a86986703",
        environment: "staging",
        /*
         * Why this gate is not optional.
         *
         * Committing two of the three values puts the reporter in its `incomplete` state whenever
         * the token is absent, and `incomplete` throws in onBegin — by design, because somebody who
         * configured two of three meant to report, and silently reporting nothing would hide the
         * typo. That is the right default for a suite whose config lives entirely in the
         * environment; here it would mean every token-less run of this suite dies before its first
         * test, which is not a price a local `scripts/e2e-run.sh` should pay.
         *
         * So: off locally when there is no token — the run behaves exactly as it did before this
         * reporter existed — and deliberately still on in CI, where a missing credential is a
         * misconfiguration that has to be loud rather than quietly unreported.
         */
        enabled: Boolean(process.env.TESBO_API_TOKEN?.trim()) || env.ci,
      },
    ],
  ],
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
