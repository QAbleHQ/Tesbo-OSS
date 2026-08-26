# Automation Integration — Test Execution API & Framework SDKs

Implementation plan for Basecamp card
[10189985971](https://app.basecamp.com/5705339/buckets/46336431/card_tables/cards/10189985971).

**Card verdict: suggestion / unbuilt feature.** Not a bug. The card is a v0.1 product spec asking for
dev scoping, so this document is the scoping answer: what the codebase already provides, what is
genuinely missing, the three traps that will waste a week if nobody names them first, and the
decisions needed before code is written.

The headline: **roughly half the card is already built.** The card's own framing ("per-project API
key — already required elsewhere in Tesbo") understates it. Auth, the run/result data model, the
idempotency guarantee, evidence storage, size/type validation and the storage-quota meter with 80/95/100%
warnings all exist and are in production use. What is missing is the *ingest surface* on top of them,
plus everything client-side.

---

## 1. What already exists (do not rebuild)

| Card asks for | Already in the codebase |
|---|---|
| §6 Auth: per-project API key | `api_tokens` — `tsbo_`-prefixed, 24 random bytes, **only** the SHA-256 hash stored, `read`/`write` scopes, `project_id`-bound. [api-token.service.ts](../Tesbo-Backend-Nest/src/auth/api-token.service.ts). Issued at `POST /api/projects/:id/apikeys`, with a working UI at [settings/api-tokens](../Tesbo-Frontend/app/\(app\)/projects/[id]/settings/api-tokens/page.tsx). Bearer path already wired in [auth.middleware.ts](../Tesbo-Backend-Nest/src/auth/auth.middleware.ts), consulted only when there is no browser session. |
| §2 Test Run | `cycles`. Carries `name`, `environment`, `build_version`, `release_name`, `status`, `started_at`, `ended_at`, plus an unused `external_id VARCHAR(64)` (V28) and a share-link mechanism. |
| §2 Test Case Result | `cycle_items` + `executions`. Statuses `Untested · Passed · Failed · Blocked · Skipped · Retest`. |
| §4 Idempotent upsert on `(run_id, case_id)` | **Already guaranteed by the schema, not by application code.** `cycle_items (cycle_id, testcase_id)` is UNIQUE and `executions.cycle_item_id` is UNIQUE. One result row per (run, case) is structurally impossible to violate. |
| §3 The Tesbo Case ID (`TES-1042`) | `testcases.external_id VARCHAR(32)`, UNIQUE per project (`idx_testcases_project_external`), with a trigram index for search. This is already the identifier the card's `tesbo.testId()` should carry — no new column needed. |
| §5 Evidence storage | Generic `attachments` table (`entity_type='execution'`), behind a storage abstraction that is local disk by default or any S3-compatible service. [storage.service.ts](../Tesbo-Backend-Nest/src/storage/storage.service.ts). Routes: `POST`/`GET /api/cycles/:cycleId/executions/:executionId/attachments`. |
| §5 Cap sizes | `EVIDENCE_MAX_FILE_SIZE` = 25MB (overridable), plus a type allowlist that deliberately excludes zip/exe, validated **all-or-nothing before a single byte is stored**. Added for Basecamp 10226296533. |
| §5 Storage quota, warn at 80%, block at 100% | `planLimits.assertStorageAvailable(orgId, bytes)` with per-plan limits, and `maybeWarnStorage` emailing the owner at 80/95/100%, at most once per threshold, resetting when usage drops. |
| Machine-actor attribution | The `agents` → `actors` trigger pattern: V58 seeds Zyra, V65 seeds `tesbo-mcp`. A `tesbo-automation` agent is one INSERT in the same shape. |
| Automation metadata on a case | `automation_status`, `automation_repo`, `automation_path`, `automation_test_name`, `automation_framework`, `automation_tags` — all present, API/MCP-writable, no UI. |
| Background job infra | BullMQ, already used by `rag` and `integration-sync`. |
| A result-recording machine call | MCP tool `record_execution_result`, with correct cross-project scope enforcement. It takes an `executionId` **UUID**, which an SDK cannot know — so it validates the model but is not the SDK's entry point. |

---

## 2. Three traps — read before touching anything

### Trap 1: `automation_runs` / `automation_jobs` / `execution_automation_reports` are dead schema for a *different* feature

Migrations V22, V23, V24, V25 and V30 create a full worker-queue schema — `script`, `start_url`,
`worker_id`, `queue_job_id`, `retry_count`, `shard_index`, `shard_total`, `execution_provider`. **No
TypeScript in this repo references any of the three tables.**

They are for **Tesbo executing the customer's tests itself**. This card is the exact inverse: the
customer's framework runs the tests and reports results in. Reusing these tables because the names
match would drag in a dispatcher model this feature has no use for.

`execution_automation_reports` is the one worth a second look — it is `UNIQUE (execution_id)` and
holds `status`, `logs_json`, `video_path`, `screenshot_path`, `trace_path`, `error_message`, which is
close to the per-result evidence record this card needs. Repurposing it is a legitimate option
(§4, decision 6); silently inheriting the other two is not.

### Trap 2: `Tesbo-Frontend/lib/api.ts` contains ~30 client functions for a *competing* design

`listTesboRuns`, `getTesboRun`, `ingestTesboPlaywright`, `listTesboSpecs`, `getTesboTestHistory`,
`listTesboAlertRules`, `createTesboRunShare`, `rotateTesboIngestionKey`, artifact upload — plus the
`TesboRunSummary` / `TesboRunCase` / `TesboSettings` types. **No page imports a single one of them.**

On the backend, six of those routes exist as stubs returning `[]` and zeroed analytics
([legacy.controller.ts:1653-1686](../Tesbo-Backend-Nest/src/legacy/legacy.controller.ts#L1653-L1686)),
recorded as unbuilt in [e2e-coverage-waves.md](e2e-coverage-waves.md) §29 and pinned by
[api/tail.spec.ts](../e2e/api/tail.spec.ts). Everything else in that client — run detail, ingest,
alerts, sharing, key rotation — has **no backend at all**.

The problem is not that it is dead. It is that it encodes the **opposite linking decision**:
`TesboRunCase` is keyed on `specName` + `title` + `fullTitle`, and `getTesboTestHistory(projectId,
specName, testName)` looks up history by test name. That is precisely the name-matching the card
rules out in §3 — *"fragile, breaks silently on refactors, and produces results attached to the wrong
case with no visible error."*

It is also a **parallel silo**: runs that live outside `cycles`, so they never appear in the run list,
the traceability matrix, the execution reports, or a test case's history.

Leaving it in place means the next person to open this card builds the wrong thing. Resolving it is
decision 1 below.

### Trap 3: `POST /cycles/from-cases` silently discards `testcaseIds`

All three of `/cycles`, `/cycles/from-plan` and `/cycles/from-cases` are wired to the *same*
`createCycle()`, which reads neither `planId`'s items nor `testcaseIds` — it inserts one `cycles` row
and returns. `from-cases` has no frontend caller and is reachable only by API. Already documented at
[FEATURE_DOCUMENTATION.md:945](FEATURE_DOCUMENTATION.md).

So "create a run containing these 40 cases" is **two calls today** (`POST /cycles`, then
`POST /cycles/:id/testcases`), and the route that looks like it does it in one silently does not.
An SDK author reading the route names will get an empty run and no error.

---

## 3. What is genuinely missing

### 3a. Run lifecycle (card §4, §6)

- **No `POST /runs` that seeds cases.** Needs to accept `testcaseIds` *or* case external IDs, and
  actually attach them (trap 3).
- **`cycles.started_at` / `ended_at`** are written only by the manual `Planning → In Progress →
  Completed` status transition (added for Basecamp 10221952787; FEATURE_DOCUMENTATION.md:960 still
  records the older state, where nothing wrote them at all, and is stale). An automated run never
  passes through those buttons, so the ingest has to stamp them itself or an automated run's
  duration reads `—` forever.
- **No close endpoint.** `PATCH /api/cycles/:cycleId` can set `status`, but nothing reconciles a
  submitted summary against the stored results.
- **No stale-run auto-close.** And there is no repeatable-job scheduler *anywhere* — both existing
  queues are add-on-demand, so the periodic sweeper is new infrastructure, not a new job.
- **No source metadata columns**: no `triggered_by`, `commit_sha`, `branch`, `build_url`.
  `cycles.external_id VARCHAR(64)` exists and is unused, but is **not unique**, so it cannot yet
  serve as a CI-run idempotency key.
- **No retry count** anywhere, which the card asks to store for visibility.

### 3b. `updateExecution` does not validate `status` — a latent 500 on the automation path

`LegacyService.EXECUTION_STATUSES` is checked in `bulkUpdateExecutionStatus` and **not** in
`updateExecution`, which is the single-result path an SDK will hammer. `status` is
`VARCHAR(32)`, so:

- `{"status": "pass"}` (the card's own wire vocabulary is lowercase `pass/fail/skip`) writes the
  literal string `pass`, which every dashboard aggregate counts as neither passed nor executed. Silent
  data corruption, no error.
- a 33-character status is an unhandled Postgres error — a 500 on user input.

This is a real pre-existing defect, not merely a hardening opportunity, and the automation ingest is
what will trip it at volume. It needs fixing regardless of which design wins, plus a
`pass|fail|skip` → `Passed|Failed|Skipped` mapping at the ingest boundary.

### 3c. Evidence is invisible in the UI

The upload and list endpoints exist. **Nothing in the frontend calls either** — there is no
`uploadExecutionAttachments`/`listExecutionAttachments` in `lib/api.ts`, and zero occurrences of
"attachment" in the execute-detail page. Screenshots, traces and videos an SDK uploads would be
stored, billed against the plan, and unviewable. Card §5 is not deliverable without this UI work.

### 3d. Quota behaviour contradicts the card

`assertStorageAvailable` **throws `ForbiddenException`** when an upload would exceed the limit. Card
§5 requires the opposite at 100%: *"new evidence uploads are skipped going forward, but the pass/fail/skip
result itself still records normally — a full quota must never block test result reporting."*
Needs a non-throwing variant plus a `skipped: quota` signal back to the SDK for the run summary.

Also: the existing meter is **per workspace/organization**; the card says per project (decision 4).

### 3e. Evidence retention (card §5)

Nothing exists. No retention column, no purge job, no Project Settings control. The dead
`tesbo-reports/settings` stub returns `traceRetentionDays: 14` — a hardcoded placeholder, not an
implementation, and not the card's 30-day default.

### 3f. No rate limiting anywhere

The card wants the results endpoint to survive 50+ parallel CI shards. There is no throttler in the
project — the only limiters are OTP-specific and the DB-backed login lockout. Load testing before GA
(card §6) needs something to test.

### 3g. The card's Playwright tag syntax does not work

Card §3 specifies, verbatim:

```ts
test('user can reset password', { tag: 'tesbo.testId("TES-1042")' }, async ({ page }) => {});
```

Playwright validates every tag against `^@` and throws
`Tag must start with "@" symbol, got "tesbo.testId("TES-1042")" instead.` at collection time
(`playwright/lib/common/index.js`). A suite written to the card **fails to load** — it does not
silently not report.

The fix lands on the card's own goal rather than away from it. With one leading `@`:

```ts
test('user can reset password', { tag: '@tesbo.testId("TES-1042")' }, async ({ page }) => {});
```

…the marker is character-for-character identical to the card's own pytest decorator and JUnit
annotation examples, both of which are already `@`-prefixed. Only the Playwright example dropped it.
§3 asked that "a developer moving from a JS repo to a Java repo recognizes it instantly"; this is
what actually delivers that.

### 3h. The SDKs, and where they live

Nothing exists for any of the three. Note this is **not just code** — it is three package registries
(npm, PyPI, Maven Central), three release pipelines, semver, and the min/max framework version matrix
the card asks for in §7. They do not belong in this repo. This is the single largest cost in the card
and the one most likely to be underestimated, since items 2–4 of the card's own build sequence read
like three tasks.

---

## 4. Decisions needed before code

1. **Kill the `Tesbo*` reporting client, or finish it?** Recommend: **build on `cycles`/`executions`
   and delete the ~30 dead client functions plus their types.** It is the card's explicit §3
   decision, and it keeps automation results inside the run list, the traceability matrix, the
   execution reports and per-case history instead of a silo. The six backend stubs stay as they are
   (`tail.spec.ts` pins them) or go in the same sweep. **What is lost:** the spec-name/test-name
   drilldowns and flaky-test history, which have real value and which case-ID linking does not
   provide. If those matter, they are a follow-up card on top of case linking, not a reason to keep
   name-matching as the primary key.
2. **Is the case ID `testcases.external_id`?** Recommend yes — nothing else is unique per project and
   human-writable. Confirms `TES-1042` is literally that column, and means `POST /results` should
   accept the external ID, not a UUID.
3. **`tesbo.testId()` mandatory or optional?** (Card's own open decision 1; recommends mandatory.)
   Note the card also asks, in §3, that untagged tests be *skipped and counted* — those two pull in
   opposite directions and the SDK can only implement one as the default. Recommend: **skip + count
   by default, with an opt-in strict mode** that fails collection. Same information, no onboarding
   cliff on day one.
4. **Storage quota per project or per workspace?** The existing meter and its warning emails are
   per-organization. Per-project means a new meter, new thresholds, and a decision about what happens
   when the project budgets sum past the workspace limit. Recommend: **keep the workspace meter,
   surface per-project usage read-only in Project Settings.**
5. **Do automation writes respect the plan read-only lock?** `ProjectWriteLockGuard` is global but
   matches only `/api/projects/:uuid/*`. So mounting the ingest under `/api/projects/:projectId/...`
   locks it on a downgraded workspace and mounting it under `/api/v1/runs/...` does not — a
   behavioural decision that route placement would otherwise make by accident. Recommend:
   **respect the lock, with the 402/403 documented in the SDK** so a CI failure is legible.
6. **New tables, or repurpose `execution_automation_reports`?** Repurposing costs a rename-in-place
   migration and inherits a good `UNIQUE (execution_id)`; new tables leave three dead ones behind.
   Recommend deciding this with §5 slice 1, not before.
7. **Stale-run timeout** — card proposes 60 min of no activity → `incomplete`. Needs a value to build
   the (new) scheduler against.
8. **Scope of the first slice.** The card's build sequence is 6 items and is realistically 3+ cards.
   Recommend slicing as §5.

---

## 5. Proposed slicing

**Slice 1 — Core ingest API (this card).** Migration for source metadata + retry count on `cycles`
and results; `POST /runs` that actually seeds cases; `POST /runs/:id/results` keyed on case external
ID with the lowercase→Titlecase status mapping; `PATCH /runs/:id/close`; `GET /runs/:id`; the
`updateExecution` status validation fix (§3b); a `tesbo-automation` agent actor; fix or document
`from-cases` (trap 3).

**Slice 2 — Evidence.** Soft-quota variant (§3d), evidence attach on the results endpoint, and the
**UI to view it** (§3c) — without which slice 1's evidence is write-only.

**Slice 3 — Playwright SDK.** Reporter hooks, graceful degradation, async submission. Validates the
slice-1 contract against a real framework, which is why the card puts it second and why it should not
be merged into slice 1.

**Slice 4 — Retention + Project Settings.** Retention column, purge job, the new repeatable-job
scheduler (shared with slice 5), usage-vs-quota display.

**Slice 5 — Stale-run auto-close.** Needs the same scheduler as slice 4; do them together.

**Slice 6 — pytest and JUnit/TestNG SDKs, CI docs.** Separate cards. Separate registries, separate
release pipelines.

**Not scoped here:** rate limiting and load testing (§3f). The card says "before GA, not after a
customer's CI breaks it", which makes it a gate on slice 3 shipping publicly, not a slice of its own.

---

## 6. Test coverage this will need

Per [CLAUDE.md](../CLAUDE.md), no slice is done until `e2e/` proves it. Impacted specs by area, so the
selection is evidence rather than a guess:

- `api/executions.spec.ts`, `api/execution-ops.spec.ts`, `api/cycles.spec.ts` — run/result lifecycle,
  the status-validation fix, upsert-on-retry, and the `from-cases` behaviour either way.
- `api/attachments.spec.ts` — evidence attach, the 25MB cap, the type allowlist, and the
  soft-quota skip that must still record the result.
- `api/authorization.spec.ts`, `api/auth.spec.ts` — an unauthenticated ingest call, and a token from
  project B reaching for project A's run.
- `api/plans.spec.ts`, `api/billing.spec.ts` — quota at 80% and at 100%, and whether a plan-locked
  project accepts automation writes (decision 5).
- `api/tail.spec.ts` — must be updated in the same commit if the `tesbo-reports` stubs move.
- `ui/executions.spec.ts` — the evidence viewer from slice 2.
- `api/testcases.spec.ts` — `external_id` as the lookup key, including a case that does not exist and
  one belonging to another project.

Edge cases to enumerate properly at Phase 1 of each slice, but the ones already visible: a case ID
that does not exist in this project; a case that exists but is not in the run; a duplicate submit
(the upsert); a lowercase `pass`; a 33-character status; an unknown status; a result posted to a
closed run; a close whose summary disagrees with the stored results; two shards posting the same case
concurrently; and evidence that pushes the workspace past 100%.


---

## 7. What was built (2026-08-25)

Decisions taken: build on `cycles`/`executions` and delete the dead client · untagged tests skipped
and counted with an opt-in `strict` mode · automation writes respect the plan read-only lock ·
scope = slices 1 + 2 + 3.

### Backend

- **[V84_automation_run_ingest.sql](../Tesbo-Backend-Nest/migrations/V84_automation_run_ingest.sql)** —
  `cycles`: `source`, `triggered_by`, `commit_sha`, `branch_name`, `build_url`, `closed_at`,
  `close_status`, `last_result_at`, plus a **partial unique index on (project_id, external_id)** that
  turns the unused V28 column into the CI idempotency key. `executions`: `duration_ms`,
  `retry_count`, `error_message`, `error_stack`, `reported_by`. `attachments`: `evidence_kind`. Seeds
  the `tesbo-automation` agent actor. The three dead automation tables (V22–V25, V30) are left
  untouched, and the migration says why.
- **[src/automation/](../Tesbo-Backend-Nest/src/automation/)** — a new module, mounted under
  `/api/projects/:projectId/automation/*` **specifically so the global `ProjectWriteLockGuard`
  covers it** (it matches only `^/api/projects/<uuid>`): `POST cases/resolve`, `POST runs`,
  `POST runs/:id/results`, `POST runs/:id/results/:caseId/evidence`, `PATCH runs/:id/close`,
  `GET runs/:id`. The controller enforces token→project scope and read/write scope itself, because
  `requireProjectAccess` authorizes the token's *user* and would otherwise let a project-A token
  drive project B.
- **`updateExecution` now validates `status`** (§3b) — the pre-existing silent-corruption path.
- **`checkStorageAvailable`** — a non-throwing sibling of `assertStorageAvailable`, so a full quota
  skips the evidence and still records the result (§3d). `assertStorageAvailable` delegates to it, so
  the two cannot drift.
- **`GET …/executions/:executionId/attachments/:attachmentId/download`** — this route did not exist.
  Evidence had been storable and listable but unreachable. Traces and logs are never served inline.

### Frontend

- Deleted the 34 dead `Tesbo*` exports from `lib/api.ts` (trap 2), replaced with the automation and
  evidence client.
- **[ExecutionEvidencePanel](../Tesbo-Frontend/components/ExecutionEvidencePanel.tsx)** — the viewer
  §5 needed; screenshots inline, traces and logs as named downloads, plus manual upload.
- **[AutomationResultMeta](../Tesbo-Frontend/components/AutomationResultMeta.tsx)** — run provenance
  (trigger · branch · commit · build link · Incomplete badge) and per-result duration/retries/error.
  Both render nothing on a manual run.
- Wired into the run detail drawer, the full-page execute screen, and the runs list.

### Playwright SDK

- **[sdk/playwright-reporter/](../sdk/playwright-reporter/)** — reporter, HTTP client with bounded
  retries that never throws, CI provenance detection for six providers, and tag parsing. 30 unit
  tests, all passing. Not published; the npm release pipeline is a separate task.

### Not in this slice

Evidence retention and the purge job, the stale-run auto-close sweeper (both need a repeatable-job
scheduler that does not exist yet), Project Settings storage/retention UI, rate limiting and load
testing, and the pytest and JUnit/TestNG SDKs. The six `tesbo-reports/*` backend stubs are left
standing with a comment marking them superseded — removing a route is a riskier change than deleting
an uncalled client, and was not part of what was approved.
