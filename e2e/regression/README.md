# Reported-ticket regressions

Regression cover for the bugs reported on the Basecamp board, written so it runs against **any**
deployment — a local compose stack, staging, or whatever a CI job is pointed at — with nothing
changed but the two base URLs and the account credentials.

```bash
# from the repo root
API_BASE_URL=https://api-app-stage.tesbo.io \
WEB_BASE_URL=https://app-stage.tesbo.io \
E2E_TEST_EMAIL=… E2E_TEST_PASSWORD=… \
E2E_DATABASE_URL=…            # optional, see below
scripts/e2e-ci.sh
```

## Why this folder exists rather than more tests in `api/` and `ui/`

`CLAUDE.md` says to extend the spec file that already owns an area. These specs are the exception,
and for one reason: **portability**. The file that owns several of these tickets (`ui/knowledge-base`,
`ui/projects-list`, `ui/testcases-repository`, `api/activity`, `api/zyra*`) reaches Postgres to build
its fixtures, so on an environment where the database is not handed out it skips itself. A ticket
regression added there would be dark exactly where it is most wanted — on the deployed environment
the bug was reported against.

So everything here goes over HTTP. **No file in this folder imports `utils/psql`,
`utils/rbac-tenant`, `utils/screens-tenant`, `utils/billing-db` or `utils/backend-logs`.** That is the
rule that makes the folder portable, and it is worth checking before adding a file:

```bash
# import statements only — a bare -rl also matches these helpers being *named* in a comment,
# which several files here legitimately do when explaining what they cannot use.
grep -rnE '^\s*import .*"\.\./\.\./utils/(psql|rbac-tenant|screens-tenant|billing-db|reports-fixture|backend-logs)"' regression/
# must print nothing
```

The rest of the suite is a different matter — see [Running everything elsewhere](#running-everything-elsewhere).

## Conventions

- **Fixtures live in account A's existing project** (`.auth/context.json`). Creating a project per run
  would collide with the Launch plan's 2-project ceiling on a workspace that already owns one. The
  cost: that project is shared, so **never assert a project-wide absolute count** — only on the
  fixtures the test itself created.
- **Every test cites its Basecamp card** in the title, via `ticket()` from `fixtures.ts`:
  `REG-ENV-01 [bc:10221899361] adding a name with no URL is refused`. So
  `grep -rn 10221899361 e2e/` finds the cover. The tracker records a whole bucket being written twice
  because ten cards were covered by specs citing no id.
- **Clean up in `finally`**, with `failOnStatusCode: false`, so a teardown running after a failed
  assertion cannot mask the real failure.
- **`test.fail()` for a ticket whose fix has not shipped** — and for nothing else. Five tests across
  four cards are marked that way, each checked against the product code on `BugFixes`, `dev` *and*
  `main` first. The convention is `api/authorization.spec.ts`'s: assert the behaviour that ought to
  hold, mark it expected-to-fail, and Playwright reports "unexpectedly passing" the moment the fix
  lands — at which point deleting the `test.fail()` line is the whole of the follow-up. Never weaken
  the assertion instead.

  **Never use it for a test that cannot pass because of how the test is written.** That is the trap
  the four Zyra cards fell into: they stubbed out the endpoint containing the fix, so `test.fail()`
  made a correct product look broken and hid the real problem, which was the spec. If a test cannot
  pass against a fixed product, the test is wrong — rewrite it. See the note below the table.

## The 36 fixed cards, and where each one is covered

13 are covered here; 23 already had cover in `api/` and `ui/` and did not need duplicating.

### Covered by this folder

| Card | Ticket | Spec | State |
|---|---|---|---|
| 10221899361 | Project settings → environment add/edit validation | `ui/tickets-project-settings.spec.ts` | **green** — fix shipped |
| 10221925706 | Test Plan — misleading "Test Run Is Not Available" | `ui/tickets-plans.spec.ts` | green |
| 10217475765 | Error page creating / opening a test suite | `api/tickets-suites.spec.ts` | green — see note |
| 10230849105 | Logout confirmation dialog missing | `ui/tickets-app-shell.spec.ts` | `test.fail()` — **not fixed** |
| 10230848426 | Search bar — clear (X) missing / ⌘K | `ui/tickets-app-shell.spec.ts` | one `test.fail()`, one green |
| 10230846264 | Sidebar — blank "Loading…" between sections | `ui/tickets-app-shell.spec.ts` | green |
| 10230839912 | My Account — validation at page end | `ui/tickets-account.spec.ts` | `test.fail()` — **not fixed** |
| 10230858713 | Signup / login — required-field markers | `ui/tickets-auth-forms.spec.ts` | 2× `test.fail()` — **not fixed** |
| 10230843780 | Members — delete icon + confirmation | `ui/tickets-members.spec.ts` | `test.fail()` — **not fixed** |
| 10231274688 | Zyra claims cases created when none were | `api/tickets-zyra.spec.ts` | green where a provider is configured |
| 10231190735 | Zyra falsely confirms archiving | `api/tickets-zyra.spec.ts` | green where a provider is configured |
| 10231965612 | Zyra shows a technical "invalid JSON" error | `api/tickets-zyra.spec.ts` | green where a provider is configured |
| 10231923903 | Zyra gives contradictory answers | `api/tickets-zyra.spec.ts` | green where a provider is configured |

Two entries need their reasoning stated rather than buried:

- **10217475765** carries no usable report — its BetterBugs session records 0 network requests, 0
  console logs and 0 user steps, and it was filed from `/plans`, not a suites screen. There is no
  repro to encode. The spec pins the contract an "error page" would violate (no 5xx from create or
  from the follow-up read, across the inputs most likely to produce one) and says so in its header.
  If a report with real evidence arrives, the specific case belongs in `api/suites.spec.ts`.
- **The four Zyra cards moved from `ui/` to `api/` on 2026-08-25, and the reasoning that put them in
  `ui/` was wrong.** That spec intercepted the chat endpoint with `route.fulfill()` and asserted the
  SCREEN annotated a false claim. But the fix is server-side — `reconcileZyraReply` rewrites the reply
  before it is stored or returned — so interception replaced the very code under test, and the tests
  could not pass however correct the product was. They carried `test.fail()`, which read as "the
  product is broken" when all four cards were fixed and unit-covered in
  `Tesbo-Backend-Nest/src/legacy/zyra-reply-guards.spec.ts` (24 passing).

  10231923903 in particular was recorded as untestable because "the behaviour lives behind the
  provider call". Its BetterBugs report shows both messages in ONE response — a failure notice, then
  the router's own "Created 7 test cases…" — which is product code composing two strings, and is
  fixed in code that cites the card.

  The replacement drives the real endpoint and asserts an invariant that holds whatever the model
  says: a reply claiming a mutation must either have persisted a `testcases[]` row carrying an `id`,
  or carry the correction saying it did not. It skips where no provider is configured (`provider:
  "none"`), which is the state of stage today — so these four are still dark there, but honestly so
  rather than red. `utils/fake-ai-server.ts` (`docs/e2e-coverage-waves.md` Wave 0 item 3) is what
  would make them run everywhere.

### Also covered outside this folder

Fifteen of these were covered ONLY by a spec that skips on a deployed environment — pinned to
`.auth/state-screens.json`, or reaching Postgres. On 2026-08-25 each gained portable cover here as
well; the original spec stays, because it can assert workspace-wide aggregates this folder cannot.
The "portable cover" column is what actually runs on stage.

| Card | Ticket | Spec | Portable cover added |
|---|---|---|---|
| 10213208002 | Test plan overall progress percentage | `ui/plans.spec.ts` | ui/tickets-plans.spec.ts |
| 10217828537 | Bug edit popup not scrollable | `ui/bugs.spec.ts` | ui/tickets-bugs.spec.ts |
| 10218564160 | Bug list delete button not visible | `ui/bugs.spec.ts` | ui/tickets-bugs.spec.ts |
| 10218723531 | Reports & Insights export buttons | `api/reports.spec.ts`, `ui/reports.spec.ts` | api+ui/tickets-reports.spec.ts |
| 10221710841 | Projects list view not showing failed | `ui/projects-list.spec.ts` | ui/tickets-dashboards.spec.ts |
| 10221720616 | Dashboard execution progress bar colours | `ui/project-dashboard.spec.ts` | ui/tickets-dashboards.spec.ts |
| 10221778177 | Test Run progress colours / progress | `ui/executions.spec.ts` | — already ran on stage |
| 10221790207 | Defect key only on failed cases | `api/executions.spec.ts`, `ui/executions.spec.ts` | — already ran on stage |
| 10221932189 | Test Plan test-case count | `ui/plans.spec.ts` | ui/tickets-plans.spec.ts |
| 10221952787 | Test Run history not showing | `api/cycles.spec.ts` | — already ran on stage |
| 10221977100 | Edit test plan field labels | `ui/plans.spec.ts` | ui/tickets-plans.spec.ts |
| 10221983132 | Plan items 0 count | `ui/plans.spec.ts` | ui/tickets-plans.spec.ts |
| 10221755377 | Logging a bug marks the case failed | `api/bugs.spec.ts` | — already ran on stage |
| 10226229423 | Bug list log-text tooltip | `ui/bugs.spec.ts` | ui/tickets-bugs.spec.ts |
| 10226234070 | Bug list edit/delete icon size | `ui/bugs.spec.ts` | ui/tickets-bugs.spec.ts |
| 10226242373 | Bug severity filter missing | `ui/bugs.spec.ts` | ui/tickets-bugs.spec.ts |
| 10226247009 | Bug priority field missing | `api/bugs.spec.ts`, `ui/bugs.spec.ts` | ui/tickets-bugs.spec.ts |
| 10226268634 | Log Bug UI consistency | `ui/executions.spec.ts` | — already ran on stage |
| 10226284379 | Linking a bug marks the case failed | `api/bugs.spec.ts` | — already ran on stage |
| 10226296533 | Bug attachment type/size validation | `api/attachments.spec.ts`, `ui/bugs.spec.ts` | api/tickets-attachments.spec.ts + ui/tickets-bugs.spec.ts |
| 10226363759 | Estimated Time accepts invalid text | `api/testcases.spec.ts` | — already ran on stage |
| 10226376787 | 500 on a long test case description | `api/testcases.spec.ts` | — already ran on stage |
| 10226480729 | Workspace dashboard labels | `ui/project-dashboard.spec.ts` | ui/tickets-dashboards.spec.ts |

Several of those files are DB-backed, so they only run on an environment where `E2E_DATABASE_URL` is
configured. That is the trade: this folder is always available, those are richer.

## Running everything elsewhere

The database transport is no longer tied to Docker. `utils/psql.ts` connects directly through
`utils/pg-runner.js` and falls back to `docker compose exec` only where the database is unreachable
from the runner, so **`E2E_DATABASE_URL` alone unlocks all 46 DB-backed spec files on a deployed
environment** — 1064 of the suite's tests that previously skipped there.

Pin `E2E_DB_TRANSPORT=direct` in CI. Without it a bad connection string falls back to a Docker that
is not present, and 46 spec files skip themselves while the job still reports success.
`scripts/e2e-ci.sh` pins it for you whenever `E2E_DATABASE_URL` is set.
