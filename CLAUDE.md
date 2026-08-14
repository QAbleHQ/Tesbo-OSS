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

### Phase 3 — Run them

Run the suite for real and show the output. Never mark this phase done from reasoning alone.

```bash
cd e2e
# point at THIS repo's stack — the defaults in .env.example are the OSS ports
API_BASE_URL=http://localhost:1021 WEB_BASE_URL=http://localhost:1020 npx playwright test
```

- Run the **new specs plus the whole area they touch**, then the full suite before declaring done.
- If the stack isn't up, use [scripts/deploy-and-test.sh](scripts/deploy-and-test.sh), which
  rebuilds the images, waits for health, and runs the suite.
- **If the suite cannot be run at all** (stack down, Docker unavailable, target unreachable):
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
- Go-ahead requires a **fully green** run. If something is genuinely out of scope to fix, leave the
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
