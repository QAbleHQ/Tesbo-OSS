# CLAUDE.md

Repo layout: [Tesbo-Backend-Nest/](Tesbo-Backend-Nest/) (NestJS API), [Tesbo-Frontend/](Tesbo-Frontend/)
(Next.js), [e2e/](e2e/) (Playwright API + UI suite), [docs/](docs/).

The local stack is booted from the repo-root [.env](.env): frontend `:1020`, backend `:1021`.
The compose defaults of `:1010`/`:1011` belong to the open-source stack, not this one.

---

## MANDATORY: the database is always the `DATABASE_URL` in the repo-root `.env`

**Never point anything at a local Postgres, for any reason.** This covers the backend, the migrator,
the e2e suite's fixture and teardown SQL, and any one-off query typed while debugging. There is no
exception for "just checking something" or "just validating this SQL".

`docker-compose.yml` defines no postgres service, but a `tesbo-test-manager-private-postgres-1`
container is still running on `:5442` with its own full, populated copy of the schema. That is what
makes this rule necessary rather than obvious: anything that reaches for a local database *succeeds*.
It connects, answers `SELECT 1`, and returns plausible rows — from a database the application has
never written to. Nothing errors, so nothing gets noticed.

It has already cost a day. The e2e psql helpers ran `psql -U postgres -d tesbo` against that
container while the API read the `.env` database, so `dbControlAvailable()` reported true, fixtures
landed where the API could not see them, and 22 tenant-owning suites died in `beforeAll` with
`Provisioned <user> but the follow-up password login still failed` — a message that reads like an
authentication bug and is not one.

- Shell access: use the container as **transport only**, never as the database —
  `docker compose exec -T postgres psql "$DATABASE_URL" -c '...'`.
- In [e2e/](e2e/): `env.dbUrl` carries this value and [utils/psql.ts](e2e/utils/psql.ts) throws when
  it is unset, rather than falling back to a local socket. Do not reintroduce that fallback.
- The `.env` database is **shared infrastructure holding real workspaces**. Read freely; treat every
  write as a production write, and keep destructive fixtures inside the disposable tenants the suite
  provisions for that purpose.

---

## MANDATORY: bug-fix work follows the Basecamp flow

Any work that starts from a Basecamp card follows [docs/basecamp-bugfix-flow.md](docs/basecamp-bugfix-flow.md).
Read it before picking a card. The essentials, because skipping them has cost real time:

- **Claim first.** Cards in To Do default to Nikunj. Assign to **Viral** (`44943233`) *before* reading or
  investigating, then move to **In progress**, so two people never work the same card.
- **A card is a claim, not a specification.** Read the BetterBugs report — `getBugDetails`,
  `getBugLogs`, `getScreenshot` — never the card title alone. Titles drift from the defect: one card
  blamed a `TEXT` description when the screenshot showed the overflow was in a `VARCHAR(512)` title.
- **Categorise before coding.** Every card is exactly one of: bug · already fixed · duplicate ·
  not a bug · unbuilt feature · suggestion. Roughly a third are not the fix they ask for — features
  misread as bugs (a password change deliberately keeps the current session) and unbuilt UI read as
  broken (a "Coming soon" button with no `onClick`) are the two that recur.
- **Reproduce before naming a mechanism**, and say so explicitly when you cannot.
- **Get approval before fixing.** State the intended change and wait. The right scope is often wider
  than the card (14 unvalidated columns, not one), narrower (the feature does not exist), a removal, or
  a behaviour decision that is not yours to make.
- **Then the e2e mandate below applies**, and the card moves to **Writing Tests** with a comment giving
  the root cause, what changed, what proves it, and what is still unverified.

Board ids, the six verdicts, and the traps that have actually bitten (stale images, the `:1011` vs
`:1021` port confusion, `audit_logs` being append-only, hooks below an early return) are all in the doc.

---

## MANDATORY: every feature or file change ships with end-to-end coverage

A change to product behaviour is **not done** until it is proven by automated end-to-end tests in
[e2e/](e2e/) that have actually been run and actually pass. No exceptions for "small" changes.

Never report a change as complete, working, or ready to go while this workflow is unfinished.

Work the four phases in order. Do not skip ahead, and do not collapse phases 1 and 2 — listing the
cases before writing them is what stops the suite from only ever covering the happy path.

### Phase 1 — Identify the scenarios and edge cases

Before writing a single test, enumerate what needs covering and state the list to the user:

- **The primary scenario** for the change — the workflow the feature exists to serve, end to end.
- **The surrounding scenarios** — the neighbouring flows this change can plausibly break, not just
  the one that was asked for. A change to test-case create also touches list, filter, pagination,
  import, and the suite it belongs to.
- **The edge cases**, deliberately hunted rather than guessed at. Work through, at minimum:
  - empty / missing / null / whitespace-only input, and the field-level validation response
  - boundaries: min and max length, 0, 1, and many; first and last page; empty result set
  - duplicates and collisions (same name, re-submit, double-click, re-run of the same test)
  - wrong type / malformed payload / unknown enum value
  - **authorization**: an unauthenticated caller, and a second tenant reaching for this resource
    (account B must get 403/404 — see [e2e/api/authorization.spec.ts](e2e/api/authorization.spec.ts))
  - **plan gating**: if the feature is affected by plan limits or a downgrade's read-only locks,
    cover both the allowed and the locked state
  - ordering and concurrency where two workers or two tabs can interleave
  - the failure path: what the UI shows when the API returns an error
  - cleanup/rollback: deleting the parent, and what happens to its children

### Phase 2 — Automate them in `e2e/`

Add specs to the existing suite; never start a parallel test project.

- API-level behaviour → [e2e/api/](e2e/api/); browser-level behaviour → [e2e/ui/](e2e/ui/). Extend
  the spec file that already owns the area (`testcases`, `projects`, `executions`, `billing`, …)
  rather than adding a near-duplicate file.
- Reuse the shared auth: [global-setup.ts](e2e/global-setup.ts) provisions the smoke tenant and
  writes `.auth/state.json` + `.auth/context.json` (`organizationId`, `projectId`). Read the
  context file; never re-implement signup or login inside a spec.
- Only add a **new dedicated tenant** (as the billing specs do) when the scenario is destructive to
  the workspace it runs in — plan transitions, downgrades, workspace deletion. Everything else
  shares account A, whose plan other specs depend on staying unrestricted.
- Every test **cleans up after itself** in a `finally` block, with `failOnStatusCode: false` on the
  teardown calls, and names its fixtures uniquely (`` `E2E ... ${Date.now()}` ``) so re-runs against
  the persistent volume don't collide.
- Specs must be **idempotent and order-independent**: `fullyParallel: false` serialises tests within
  a file, but different files still run concurrently across workers.
- Assert on **user-visible outcomes and persisted state** — the API response after the UI action,
  not merely that a toast appeared.
- Never touch Stripe write APIs. Those are gated behind `E2E_BILLING_ALLOW_STRIPE_WRITES` because
  the configured key is frequently a **live** key. Drive billing states via locally signed webhooks
  and the DB helpers in [e2e/utils/](e2e/utils/).
- Comment any non-obvious locator or workaround with *why* — the existing specs do this (e.g.
  modals that render without `role="dialog"`).

### Phase 3 — Run the impacted tests, and say what you selected

Run the tests for real and show the output. Never mark this phase done from reasoning alone.

**Run the impacted areas only — the full suite is not the default.** Every statement costs a round
trip to the hosted database, so a full run takes tens of minutes and buries the handful of results
that actually speak to this change. Scope the run to the specs the change can reach, and be explicit
about that scope so the user can see what was and wasn't exercised.

#### 3a — Select the impacted specs

Map every changed product file to the specs that exercise it:

- `Tesbo-Backend-Nest/src/<module>/…` → [e2e/api/](e2e/api/)`<module>.spec.ts`. The names line up:
  `testcases`, `suites`, `cycles`, `executions`, `execution-ops`, `bugs`, `projects`, `workspaces`,
  `invitations`, `plans`, `reports`, `integrations`, `knowledge-base`, `custom-fields`,
  `attachments`, `import-export`, `zyra`.
- A `Tesbo-Frontend/` screen → the matching [e2e/ui/](e2e/ui/) spec **plus** the API spec for the
  endpoints that screen calls. A UI change that alters a request is an API-area change too.
- Guards, session, tokens, roles → add `api/auth.spec.ts`, `api/authorization.spec.ts`,
  `api/rbac.spec.ts`.
- Entitlements, plan limits, read-only locks → add `api/plans.spec.ts`, `api/billing.spec.ts`,
  `ui/billing.spec.ts`.
- A shared entity, DTO or migration → add the spec of **every** module that reads that table, not
  only the one you edited.
- Unsure which spec owns a behaviour? `grep` the endpoint path, the DB column or the on-screen
  string across `e2e/` and let the hits choose the files. Selection is evidence, not a guess — and
  if grep finds nothing, that area is uncovered and Phase 2 isn't finished.

#### 3b — Count the selection and announce it *before* running

`--list` resolves the same selection the run will use, without executing any test:

```bash
cd e2e
npx playwright test api/testcases.spec.ts ui/testcases.spec.ts --list | tail -1   # selected
npx playwright test --list | tail -1                                             # suite total
```

State it to the user in one line before the run starts, naming the areas and both numbers:

```
Impacted: testcases (api + ui), suites (api)
Selected 63 of 512 tests across 3 files — running 63.
```

If the count contradicts what you expected — a `-g` that matched nothing, a mistyped path, a
`--project` that excluded half the selection — fix the selection before running. **A run of 0 tests
is a failed selection, not a pass.**

#### 3c — Run exactly that selection

**Four conditions gate every run. All four, every time — no exceptions for a quick re-check.**

0. **Deploy first — test what you actually changed.** New code is not in the running containers
   until the images are rebuilt, so a run against yesterday's images tests yesterday's product.
   `scripts/e2e-run.sh` now refuses to start when any file under `Tesbo-Backend-Nest/src`,
   `Tesbo-Backend-Nest/migrations`, `Tesbo-Frontend/app`, `Tesbo-Frontend/components` or
   `Tesbo-Frontend/lib` is newer than the image built from it, and names the deploy command instead.
   **If you changed product code, the run command is `scripts/deploy-and-test.sh`, not
   `scripts/e2e-run.sh`** — it rebuilds, waits for health, applies migrations, and then hands the run
   to `e2e-run.sh` so the three conditions below still hold.
1. **Ask first, and wait.** State the selection and the exact command, then stop and wait for the
   user's go-ahead. A run saturates the machine for minutes and writes to shared infrastructure;
   the user decides when that starts, not you. Never launch one as a side effect of another task.
2. **`--workers=10`.** Playwright's default here is 5 (half of this box's 10 logical cores), so the
   flag is not optional and is not the config default — pass it explicitly. **If the run cannot be
   given 10 workers, do not run it**; report the blocker instead.
3. **Its own Terminal window.** Runs go through [scripts/e2e-run.sh](scripts/e2e-run.sh), which
   opens a Terminal.app window streaming live logs and tees to `e2e/.run-logs/<stamp>.log`. Output
   buried in an agent's tool call is not a visible run.

```bash
# Changed product code? This is the command. Rebuilds backend/frontend/migrator from the working
# tree, waits for both to report healthy, then execs e2e-run.sh with the same arguments.
scripts/deploy-and-test.sh api/testcases.spec.ts ui/testcases.spec.ts

# Only when the images already contain the code under test (e2e-run.sh verifies this and exits 6
# if not). Announces the selection, refuses a 0-test selection, refuses to start while another run
# holds e2e/.auth/state.json, then opens the window at --workers=10.
scripts/e2e-run.sh api/testcases.spec.ts ui/testcases.spec.ts
```

> Why condition 0 exists: on 2026-08-24 a 258-test run came back 194/64, and **every one of the 64
> failures was code missing from images built seven hours earlier** — an export route that did not
> exist yet, a renamed dashboard tile, a validation rule. A red run against stale images reads
> exactly like a broken product, and costs an afternoon before anyone checks `docker compose images`.
> A rebuild also deploys whatever else is in the shared worktree, including another session's
> in-flight work and its migrations — check `git status` before deploying, and say what is going out.

The machine is an Apple M1 Max — 10 logical cores, 32 GB. API specs are network-bound on Neon and
leave the CPU idle, so 10 workers costs nothing there. UI specs each carry a Chromium, and the
backend `:1021` and frontend `:1020` share this box, so a UI-heavy selection at 10 will oversubscribe
the CPU and make the contention flakes catalogued in
[docs/e2e-coverage-waves.md](docs/e2e-coverage-waves.md) §"Contention flakes" more likely. That is an
accepted cost of the mandate: re-confirm a suspected contention flake at `--workers=1` before
reporting it as a failure — never by lowering the workers on the whole run.

- While iterating on a single new test, narrow further with `-g "TC-042"` — but the impacted
  **files** must go green in one run before this phase is done. A passing `-g` slice is not the
  phase.
- Close the loop on the number you announced: report `63 selected / 63 ran / 61 passed / 2 failed`
  and name the failures. If fewer ran than were selected — a `beforeAll` blew up, the run aborted,
  a worker died — say so explicitly. A short run is not a green run.
- Never widen the selection to make a red run look proportionally smaller, and never trim it to drop
  a failing file. Phase 4 applies to every test in the selection.

#### 3d — When the whole suite does run

Full-suite runs are opt-in. Run one when the user asks for it, or when the change is genuinely
global — [e2e/global-setup.ts](e2e/global-setup.ts), [e2e/utils/](e2e/utils/),
[playwright.config.ts](e2e/playwright.config.ts), auth/session middleware, or a migration that moves
data other modules read. Say that you're doing it and why, and announce the count the same way.

- [scripts/deploy-and-test.sh](scripts/deploy-and-test.sh) is also what to use when the stack isn't
  up at all. It forwards its arguments through to the run, so hand it the impacted specs either way:
  `scripts/deploy-and-test.sh api/testcases.spec.ts`. With no specs named it deploys and stops,
  rather than quietly running everything.
- **If the tests cannot be run at all** (stack down, Docker unavailable, target unreachable):
  **stop and report.** State which phase you reached and what is blocking it, and ask the user to
  bring the stack up. Do not rebuild or restart their stack unprompted, do not substitute unit
  tests or a type-check for this phase, and do not call the change done. Written-but-unrun specs
  are an unfinished task, not a deliverable.

### Phase 4 — A failure is a product bug until proven otherwise

When a test fails, the default assumption is that **the product is missing or wrong**, not that the
test is too strict.

- Diagnose the failure, fix it in the **product code** (backend/frontend), and re-run.
- Only adjust the test when you can point at the concrete reason the *expectation* was wrong (an
  incorrect endpoint, a stale selector, a genuinely mistaken assumption about intended behaviour) —
  and say so explicitly to the user.
- **Never** delete a test, weaken an assertion, add a `test.skip`, loosen a matcher, or widen a
  timeout to turn a red run green. That converts a real defect into silent debt.
- Go-ahead requires a **fully green run of the whole selected impact set** — not of a narrowed
  re-run that leaves the red file out. If something is genuinely out of scope to fix, leave the
  test in place, report it as a known failure with the reason, and let the user decide — never
  quietly neutralise it.

### Scope of this rule

The baseline: **any change that alters what the product does**, anywhere in
`Tesbo-Backend-Nest/` or `Tesbo-Frontend/`. On top of that:

- **Schema and migration changes** get end-to-end coverage too, even when no endpoint visibly
  changed — new columns, migrations, and index changes must be exercised through the real API.
- **Pure refactors** (no behaviour change) don't always need new specs, but you must *run* the
  existing coverage for the refactored path to prove that. If that path turns out to be untested,
  the refactor is not exempt — write the missing tests first, so the suite can show the behaviour
  is unchanged.
- **Bug fixes require a regression test**: a spec that reproduces the exact edge case behind the
  bug, that **fails before the fix and passes after**. Confirm both directions — run it against the
  unfixed code (or explain concretely why the failure is already demonstrated) before applying the
  fix. A fix without a failing-first test does not satisfy this rule.

Exempt: docs, comments, formatting, and changes wholly inside `e2e/` itself.
