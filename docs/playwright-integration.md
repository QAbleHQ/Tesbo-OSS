# Report Playwright results into Tesbo

`@tesbox/playwright-reporter` is a Playwright reporter. You add it to your own Playwright project,
tag each test with the Tesbo test case it validates, and every run posts its results back into
Tesbo — as one Test Run (Cycle) containing those cases, with pass/fail, duration, error text and
failure evidence.

Nothing about your suite changes except the reporter list and the tags. Your tests still run exactly
as they did, and a Tesbo outage cannot fail them — see
[It will not break your pipeline](#it-will-not-break-your-pipeline).

> **Availability.** The package is not on the public npm registry yet. Until it is published, install
> it from this repository — see [Install from source](#appendix--install-from-source). Every other
> step is identical.

---

## What happens on a run

| When | What the reporter does |
| --- | --- |
| Before the first test | Collects every `@tesbo.testId(...)` tag, checks the ids exist in your project, and opens **one** Test Run with those cases attached |
| As each test finishes | Posts that result — status, duration, retry count, and on failure the error message and stack |
| On a failure | Uploads Playwright's screenshots, video and trace as evidence on that case |
| At the end | Closes the run with a summary, and prints any disagreement between what it sent and what Tesbo stored |

One run per `playwright test` invocation — never one per test.

Automation **reports results only.** It never creates or approves a test case. A tag pointing at a
case that does not exist is reported as an error rather than helpfully creating one, because your QA
engineers own the repository.

---

## Before you start

You need:

- **Node.js 20** or newer, and **Playwright 1.42** or newer (it is a peer dependency).
- **A Tesbo project** with the test cases you want to report against already created.
- **Each case's ID** as shown in Tesbo — e.g. `TES-1042`. This is the linking key, not an internal
  UUID.
- **A project API token** with the `read` and `write` scopes, from
  **Project → Settings → API & MCP**. It is scoped to one project: a token issued for project A
  cannot report into project B.

---

## Step 1 — Install

In your Playwright project:

```bash
npm install --save-dev @tesbox/playwright-reporter
```

## Step 2 — Collect your three values

All three live under **Project → Settings → API & MCP** in Tesbo:

| Value | Environment variable | Notes |
| --- | --- | --- |
| API host | `TESBO_BASE_URL` | e.g. `https://api-app.tesbo.io`. **No default** |
| Project ID | `TESBO_PROJECT_ID` | The project UUID results are reported into |
| API token | `TESBO_API_TOKEN` | Starts `tsbo_`; needs `read` and `write` |

> **The single most common setup mistake.** `TESBO_BASE_URL` is your **API** host, not the web app
> host. Tesbo serves them separately and the app host has no `/api` route, so pointing at the app
> makes every call 404 — and because the reporter never breaks your suite, the run stays green with
> no results in Tesbo. There is deliberately no default for this reason. `doctor` detects it and
> names the host you probably want.

**Shortcut:** paste the MCP URL from that same settings page
(`https://…/api/projects/<uuid>/mcp`) as `TESBO_BASE_URL`. It is trimmed to the origin and the
project UUID is read out of it, so one paste configures two of the three values.

## Step 3 — Verify the values before wiring anything up

```bash
npx @tesbox/playwright-reporter init
```

`init` asks for all three values, checks they actually work together, offers to write the token to
`.env` (warning you first if `.env` is not in `.gitignore`), and prints the config block to paste.

To check an existing setup instead — including in CI, where it prompts for nothing and just reports:

```bash
npx @tesbox/playwright-reporter doctor
```

| Exit code | Meaning |
| --- | --- |
| `0` | Reachable, token valid, scoped to this project |
| `1` | Verification failed — the reason and a hint are printed |
| `2` | Not configured, or configured incompletely |

Both commands only ever **read**, so they are safe to run against production. The probe confirms the
`read` scope; `write` can only be confirmed by an actual run, because a write probe would leave an
undeletable empty run behind in your project.

> **Why a CLI and not a prompt at run time.** A Playwright reporter runs inside a non-interactive
> test process, usually on a CI runner with no TTY. A prompt there does not ask anyone anything — it
> hangs the job until it times out. So the reporter fails fast and says what is missing, and the
> asking happens in a command a human runs.

## Step 4 — Register the reporter

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: [
    ['list'],
    ['@tesbox/playwright-reporter', {
      // Not secrets — commit them. A self-hosted install needs its own baseUrl in version control.
      baseUrl: 'https://api-app.tesbo.io',
      projectId: '<your-project-uuid>',
      environment: 'staging',
      // The token is a secret: leave it in TESBO_API_TOKEN, never in this file.
    }],
  ],
});
```

Keep `['list']` (or whichever reporter you already use). The Tesbo reporter adds to your reporter
list; it does not replace your console output.

Every option can come from its environment variable instead, so a config with no Tesbo block at all
still works if the three variables are set.

## Step 5 — Tag each test with the case it validates

```ts
import { test, expect } from '@playwright/test';

test('user can reset password', { tag: '@tesbo.testId("TES-1042")' }, async ({ page }) => {
  await page.goto('/forgot-password');
  await page.getByLabel('Email').fill('user@example.com');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText('Check your email')).toBeVisible();
});
```

`TES-1042` is the test case's ID as shown in Tesbo.

> **Note the leading `@`.** Playwright validates every tag against `^@` and throws
> `Tag must start with "@" symbol` at collection time otherwise — so the unprefixed
> `tesbo.testId("TES-1042")` will not load your suite at all. With the `@`, the marker is
> character-for-character the same as the pytest decorator and the JUnit annotation.

An annotation works too, for ids computed at runtime:

```ts
test('...', { annotation: { type: 'tesbo', description: caseId } }, async () => {});
```

A test may declare **exactly one** case id. Two is reported as an error rather than resolved by a
coin flip, because the alternative is a result silently attached to the wrong case.

### Untagged tests

By default they are **skipped and counted**, and the run summary says `N test(s) not linked to
Tesbo`. Adopting the reporter on an existing suite does not turn it red. Set `strict: true` to fail
at collection time instead — on an untagged test, an unreadable marker, or an id that does not exist
in your project.

## Step 6 — Run it, and check what it says

```bash
TESBO_API_TOKEN=tsbo_… npx playwright test
```

The reporter prints its own lines alongside your usual output:

```
[tesbo] reporting 14 linked test(s) to run 8f2c… 
[tesbo] run 8f2c… closed (completed): 12 passed, 2 failed, 0 skipped
[tesbo] 3 test(s) not linked to Tesbo (no @tesbo.testId("<CASE_ID>") tag).
```

Then open **Project → Cycles (Test Runs)** in Tesbo. Your run is there, containing the tagged cases
with their results; open a failed case to see the error message and its evidence.

**Read those `[tesbo]` lines.** Because the reporter cannot fail your suite, they are the only place
a problem is visible — a lost request, an unknown case id, or a storage quota that dropped evidence.

---

## Reference

### Options

Every option may be set inline in `playwright.config.ts`; the first three fall back to environment
variables. Inline values win.

| Option | Default | Notes |
| --- | --- | --- |
| `baseUrl` | `TESBO_BASE_URL` | Required; the API host. No fallback default |
| `projectId` | `TESBO_PROJECT_ID` | |
| `token` | `TESBO_API_TOKEN` | |
| `runName` | derived from the CI context | e.g. `E2E #128` |
| `environment`, `buildVersion`, `releaseName` | — | Recorded on the run for filtering |
| `strict` | `false` | About the *suite*: fail on untagged tests, bad markers, unknown ids |
| `requireConfig` | `false` | About the *environment*: fail when nothing is configured |
| `attachEvidence` | `'failed'` | `'always'` or `'never'`. `'always'` costs storage on every passing test |
| `enabled` | `true` | `false` disables without editing the reporter list |
| `timeoutMs` | `15000` | Per request |
| `retries` | `3` | Attempts per request, for transient failures only |

### Configured, half-configured, and not configured

| State | Behaviour |
| --- | --- |
| All three set | Reports normally |
| **None** set | Warns and reports nothing; your suite still passes. A fork's PR build with no secrets keeps working |
| **Some** set | **Fails at collection time.** Nobody half-configures a reporter on purpose, and a run that quietly reported nothing looks exactly like one that succeeded |

Set `requireConfig: true` to make the middle row an error too.

### How statuses map

| Playwright | Recorded in Tesbo |
| --- | --- |
| `passed` | pass |
| `failed` | fail |
| `skipped` | skip |
| `timedOut` | timedOut |
| `interrupted` | interrupted |

A flaky test that Playwright retries is upserted on (run, case): the last attempt stands, and the
retry count records how many there were.

### Evidence

On a failure, Playwright's own attachments are uploaded and grouped by kind:

| Extension | Kind |
| --- | --- |
| `png`, `jpg`, `jpeg`, `webp` | screenshot |
| `mp4`, `webm`, `mov` | video |
| `zip` | trace |
| `txt`, `log`, `json`, `md`, `xml` | log |

Files over 25 MB are skipped locally rather than uploaded and rejected. Evidence counts against your
workspace's plan storage; at 100% Tesbo **skips the file and still records the result**, so a full
quota never costs you a pass/fail. The reporter prints how many files were skipped.

Set `attachEvidence: 'always'` to also attach evidence for passing tests — a suite of 2,000 passing
tests each carrying a trace can fill a workspace's whole allowance in one run, so weigh it.

### CI provenance, captured for free

GitHub Actions, GitLab CI, Jenkins, CircleCI, Azure Pipelines and Bitbucket Pipelines are detected
automatically. The commit SHA, branch and a link to the build are recorded on the run, so a failure
traces back to an exact commit without leaving Tesbo. A local run is labelled `local`.

**Sharding works.** Every shard of one CI attempt shares an idempotency key, so the shards converge
on a single run rather than opening one each. A *re-run* of the workflow deliberately gets its own
run — overwriting the first attempt would destroy the record you re-ran in order to compare against.

Nothing needs configuring for any of this.

### It will not break your pipeline

**A Tesbo outage must never fail your suite.** Every call resolves rather than throwing: failures are
retried with backoff, then logged and counted, and the end-of-run summary says how many requests were
lost. The reporter never touches the process exit code — your suite's pass/fail stays Playwright's
decision alone.

The only exception is `strict: true`, which fails deliberately at collection time because the project
asked it to.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Suite is green, nothing appears in Tesbo | Almost always `TESBO_BASE_URL` pointing at the web app host instead of the API host. Run `doctor` |
| Fails at collection with "configuration incomplete" | One or two of the three values are set. Deliberate, not a bug — see the table above |
| `Tag must start with "@" symbol` | The tag is missing its leading `@`. Use `@tesbo.testId("TES-1042")` |
| `N tagged case id(s) not found in Tesbo` | A tag points at a case that does not exist in this project — check for a typo or a deleted case |
| `This API token is not scoped to this project` | The token belongs to another project. Mint one under this project's settings |
| `requires the "write" scope` | The token has `read` only. Reporting results needs both |
| `N test(s) not linked to Tesbo` | Expected while adopting. Those tests have no tag and were not reported |
| Tesbo's stored counts differ from this run's | Some result posts were lost. This line is the only place that is visible — treat it as real |

`doctor` diagnoses the first six directly, and is the fastest first move for any of them.

---

## Appendix — install from source

Until the package is published to npm, build it from this repository and install the tarball into
your Playwright project:

```bash
# in this repository
cd sdk/playwright-reporter
npm install
npm run build
npm pack                      # produces tesbo-playwright-reporter-<version>.tgz

# in your Playwright project
npm install --save-dev /path/to/tesbo-playwright-reporter-<version>.tgz
```

Everything from [Step 2](#step-2--collect-your-three-values) onward is unchanged. The `npx
@tesbox/playwright-reporter` commands become `npx tesbo-playwright` once installed locally.
