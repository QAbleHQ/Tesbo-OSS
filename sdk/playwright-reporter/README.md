# `@tesbo/playwright-reporter`

Reports Playwright results into Tesbo, linked to the test cases they validate.

Automation **reports results only**. It never creates or approves a test case — QA engineers own
those, and a tag pointing at a case that does not exist is reported as an error, not helpfully
created.

## Install

```bash
npm install --save-dev @tesbo/playwright-reporter
```

> Not published yet. This package lives in the Tesbo repo at `sdk/playwright-reporter`; the npm
> release pipeline is a separate task. To try it now, `npm run build` here and point Playwright at
> the built directory.

## Configure

```ts
// playwright.config.ts
export default defineConfig({
  reporter: [
    ['list'],
    ['@tesbo/playwright-reporter', {
      // both default to env vars, which is where a token belongs
      projectId: process.env.TESBO_PROJECT_ID,
      token: process.env.TESBO_API_TOKEN,
      baseUrl: process.env.TESBO_BASE_URL,
      environment: 'staging',
    }],
  ],
});
```

Create the token in Tesbo under **Project → Settings → API tokens**. It needs the `write` scope, and
it is scoped to one project — a token issued for project A cannot report into project B.

| Variable | Purpose |
|---|---|
| `TESBO_PROJECT_ID` | The project results are reported into |
| `TESBO_API_TOKEN` | Project API token (`tsbo_…`) |
| `TESBO_BASE_URL` | Your Tesbo URL. Defaults to `https://app.tesbo.io` |

## Link a test to a case

```ts
test('user can reset password', { tag: '@tesbo.testId("TES-1042")' }, async ({ page }) => {
  // ...
});
```

`TES-1042` is the test case's ID as shown in Tesbo.

> **Note the leading `@`.** Playwright validates every tag against `^@` and throws
> `Tag must start with "@" symbol` at collection time otherwise — so the unprefixed
> `tesbo.testId("TES-1042")` will not load. With the `@`, the marker is character-for-character the
> same as the pytest decorator and the JUnit annotation.

An annotation works too, for ids computed at runtime:

```ts
test('...', { annotation: { type: 'tesbo', description: caseId } }, async () => {});
```

A test may declare **exactly one** case id. Two is an error rather than a coin flip, because the
alternative is a result silently attached to the wrong case.

## What happens on a run

1. **Before any test runs**, the reporter collects every tagged id and validates it against your
   project, then opens **one** Test Run — not one per test.
2. **As each test finishes**, its result is posted with duration, retry count and, on failure,
   Playwright's error message. Submission is non-blocking: it never sits between two tests.
3. **On failure**, screenshots, video and the trace are attached as evidence.
4. **At the end**, the run is closed with a summary, and Tesbo reconciles it against what it actually
   stored — any disagreement is printed, which is the only place a dropped result is visible.

## Untagged tests

By default they are **skipped and counted**, and the run summary says
`N test(s) not linked to Tesbo`. Adopting the reporter on an existing suite does not turn it red.

Set `strict: true` to fail at collection time instead — on an untagged test, an unreadable marker, or
an id that does not exist in the project.

## Options

| Option | Default | Notes |
|---|---|---|
| `projectId` | `TESBO_PROJECT_ID` | |
| `token` | `TESBO_API_TOKEN` | |
| `baseUrl` | `TESBO_BASE_URL`, then `https://app.tesbo.io` | |
| `runName` | derived from the CI context | e.g. `E2E #128` |
| `environment`, `buildVersion`, `releaseName` | — | Recorded on the run for filtering |
| `strict` | `false` | See above |
| `attachEvidence` | `'failed'` | `'always'` or `'never'`. `'always'` costs storage on every passing test |
| `enabled` | `true` | `false` disables without editing the reporter list |
| `timeoutMs` | `15000` | Per request |
| `retries` | `3` | Attempts per request, transient failures only |

## CI provenance, captured for free

GitHub Actions, GitLab CI, Jenkins, CircleCI, Azure Pipelines and Bitbucket Pipelines are detected,
and the commit SHA, branch and a link to the build are recorded on the run — so a failure traces back
to an exact commit without leaving Tesbo. A local run is labelled `local`.

**Sharding works.** Every shard of one CI attempt shares an idempotency key, so they converge on a
single run rather than opening one each. A *re-run* of the workflow deliberately gets its own run —
overwriting the first attempt would destroy the record you re-ran in order to compare against.

## It will not break your pipeline

Card §7, and the rule this package is built around: **a Tesbo outage must never fail your suite.**

Every call to Tesbo resolves rather than throwing. Failures are retried with backoff, then logged and
counted, and the end-of-run summary says how many requests were lost. The reporter never touches the
process exit code — your suite's pass/fail is Playwright's decision alone.

The only exception is `strict: true`, which fails deliberately at collection time because the project
asked it to.

## Storage quota

Evidence counts against your workspace's plan storage. At 100% Tesbo **skips the evidence and still
records the result** — a full quota never costs you a pass/fail. The reporter prints how many files
were skipped.

## Develop

```bash
npm install
npm run build
npm test        # compiles, then runs the unit tests
```
