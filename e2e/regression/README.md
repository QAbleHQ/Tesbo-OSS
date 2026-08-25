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
- **`test.fail()` for a ticket whose fix has not shipped.** Nine tests across eight cards are marked
  that way. Each one was checked against the product code on `BugFixes`, `dev` *and* `main` before the marker went
  on. The convention is `api/authorization.spec.ts`'s: assert the behaviour that ought to hold, mark
  it expected-to-fail, and Playwright reports "unexpectedly passing" the moment the fix lands —
  at which point deleting the `test.fail()` line is the whole of the follow-up. Never weaken the
  assertion instead.

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
| 10231274688 | Zyra claims cases created when none were | `ui/tickets-zyra.spec.ts` | `test.fail()` |
| 10231190735 | Zyra falsely confirms archiving | `ui/tickets-zyra.spec.ts` | `test.fail()` |
| 10231965612 | Zyra shows a technical "invalid JSON" error | `ui/tickets-zyra.spec.ts` | `test.fail()` |
| 10231923903 | Zyra gives contradictory answers | `ui/tickets-zyra.spec.ts` | **skipped** — needs a fake AI server |

Two entries need their reasoning stated rather than buried:

- **10217475765** carries no usable report — its BetterBugs session records 0 network requests, 0
  console logs and 0 user steps, and it was filed from `/plans`, not a suites screen. There is no
  repro to encode. The spec pins the contract an "error page" would violate (no 5xx from create or
  from the follow-up read, across the inputs most likely to produce one) and says so in its header.
  If a report with real evidence arrives, the specific case belongs in `api/suites.spec.ts`.
- **10231923903** is skipped, not faked. What it is about — whether the *model* contradicts itself —
  lives behind the provider call, so intercepting the endpoint would replace the very component under
  test and assert the fixture back to itself. Blocked on `utils/fake-ai-server.ts`
  (`docs/e2e-coverage-waves.md` Wave 0 item 3).

### Already covered outside this folder

| Card | Ticket | Spec |
|---|---|---|
| 10213208002 | Test plan overall progress percentage | `ui/plans.spec.ts` |
| 10217828537 | Bug edit popup not scrollable | `ui/bugs.spec.ts` |
| 10218564160 | Bug list delete button not visible | `ui/bugs.spec.ts` |
| 10218723531 | Reports & Insights export buttons | `api/reports.spec.ts`, `ui/reports.spec.ts` |
| 10221710841 | Projects list view not showing failed | `ui/projects-list.spec.ts` |
| 10221720616 | Dashboard execution progress bar colours | `ui/project-dashboard.spec.ts` |
| 10221778177 | Test Run progress colours / progress | `ui/executions.spec.ts` |
| 10221790207 | Defect key only on failed cases | `api/executions.spec.ts`, `ui/executions.spec.ts` |
| 10221932189 | Test Plan test-case count | `ui/plans.spec.ts` |
| 10221952787 | Test Run history not showing | `api/cycles.spec.ts` |
| 10221977100 | Edit test plan field labels | `ui/plans.spec.ts` |
| 10221983132 | Plan items 0 count | `ui/plans.spec.ts` |
| 10221755377 | Logging a bug marks the case failed | `api/bugs.spec.ts` |
| 10226229423 | Bug list log-text tooltip | `ui/bugs.spec.ts` |
| 10226234070 | Bug list edit/delete icon size | `ui/bugs.spec.ts` |
| 10226242373 | Bug severity filter missing | `ui/bugs.spec.ts` |
| 10226247009 | Bug priority field missing | `api/bugs.spec.ts`, `ui/bugs.spec.ts` |
| 10226268634 | Log Bug UI consistency | `ui/executions.spec.ts` |
| 10226284379 | Linking a bug marks the case failed | `api/bugs.spec.ts` |
| 10226296533 | Bug attachment type/size validation | `api/attachments.spec.ts`, `ui/bugs.spec.ts` |
| 10226363759 | Estimated Time accepts invalid text | `api/testcases.spec.ts` |
| 10226376787 | 500 on a long test case description | `api/testcases.spec.ts` |
| 10226480729 | Workspace dashboard labels | `ui/project-dashboard.spec.ts` |

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
