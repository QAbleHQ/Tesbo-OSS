# Tesbo load & performance suite (k6)

Load and performance scenarios for **app.tesbo.io**, written to validate the production
infrastructure upgrade.

Everything here is driven by environment variables and targets the real API. Read
[Safety](#safety-this-writes-to-production) before the first run.

```bash
brew install k6
```

---

## What this measures, and why these endpoints

The scenarios were derived from the code, not guessed. The numbers below are the real limits the
production stack enforces today, and they are what the thresholds are set around:

| Limit | Value | Where |
|---|---|---|
| Test-case list page ceiling | **500** (`limit` clamped; default 100, UI default 25) | `legacy.service.ts` `listTestCases` |
| Bulk-create batch ceiling | **500** per request | `LegacyService.MAX_BULK_TESTCASES` |
| Add-cases-to-run ceiling | **none** — the whole selection in one body | `addCycleTestCases` |
| Run executions read | **no pagination at all** | `GET /api/cycles/:id/executions` |
| Postgres statement timeout | **30s** | `DB_STATEMENT_TIMEOUT_MS` |
| PG pool size | **20** connections | `DB_POOL_MAX` |
| Pool acquire timeout → 503 | **10s** | `DB_CONNECTION_TIMEOUT_MS` |
| Cloudflare proxy limit → 524 | **100s** | recorded in `addCycleTestCases`'s own comment |
| Request body limit | **20 MB** | `MAX_REQUEST_BODY_SIZE` |

Three of these are the reason this suite exists:

1. **`GET /api/cycles/:id/executions` is unbounded.** It takes no `limit`/`offset` and returns every
   execution with the full test case body inlined — `description`, `preconditions`,
   `postconditions`, `steps`, `test_data`. The run detail screen calls it once and holds the whole
   result in React state, filtering and counting client-side. A 5000-case regression run is the
   largest single response the product can be asked to produce, and there is no server-side cap on
   it. `op_run_open_executions_bytes` is the headline number.

2. **"Select all → add to run" is 11 requests, not one.** The client does not send a flag; it walks
   the entire repository at the 500-row ceiling to collect ids (10 sequential round trips for 5000
   cases) and only then POSTs them. Those ten reads are on the user's clock before the write starts.

3. **That write has production history.** `addCycleTestCases`' own comment records it timing out at
   Cloudflare's 100s limit and surfacing as a 524. It is one statement now, but that statement runs
   under a 30s `statement_timeout` — two distinct cliffs, which the client classifies apart.

`tesbo_cloudflare_524`, `tesbo_db_unavailable_503` and `tesbo_transport_failures` are tracked as
separate counters throughout, because all three arrive as "not a 200" and each points at a
different layer:

- **status 0** — no HTTP response: connection reset or DNS. The shape the keep-alive bug produced.
- **524** — Cloudflare gave up at 100s; the origin may still be running the statement.
- **503** — `DatabaseService` could not get a pool connection in 10s. With `DB_POOL_MAX=20` and 50
  VUs offered, this is the direct read on whether the pool is the ceiling. The backend logs a pool
  census beside it: `waiting>0, idle=0` means raise `max`; `waiting=0` means look upstream at Neon.

---

## The scenarios

| Script | What it answers | Writes? | Concurrency |
|---|---|---|---|
| `seed.js` | Build the 5000-case fixture | **yes** | 1 VU |
| `s1-repository.js` | How does a 5000-case repository read? | no | ramps to `VUS` |
| `s2-run-build.js` | Can we build 5-10 runs of 5000 cases each? | **yes** | `BUILD_VUS` (2) |
| `s3-mixed-50vu.js` | 50 users doing all of it at once | **yes** | ramps to `VUS` (50) |
| `s4-breakpoint.js` | Where is the knee? | no | open model to `PEAK_RPS` |
| `teardown.js` | Remove every fixture | deletes | 1 VU |

### Scenario 1 — repository at 5000 cases (read-only)

Models the screen, not an endpoint. Opening the repository fires four requests before the user does
anything (project, suite tree, summary tiles, first page at the UI's default size of 25). Then it
separates four distinct pressures so the summary says which one hurts:

- `op_repo_open_page` — the first page. What "the repository is slow" actually means.
- `op_repo_page_deep` — `offset` ≈ 4900. `OFFSET` makes Postgres walk and discard every skipped row.
  **If this diverges sharply from `op_repo_open_page`, keyset pagination is the fix and no amount of
  extra hardware substitutes for it.**
- `op_repo_search` — `LIKE '%term%'` against the V82 trigram indexes. Confirms they are actually
  chosen at this row count rather than falling back to a sequential scan.
- `op_repo_filter` — equality filters riding `idx_testcases_status`.

### Scenario 2 — building regression runs (writes)

One iteration = one complete "build a regression run" journey: create the run → walk 10 pages to
collect 5000 ids → add them → open the run. `RUN_COUNT=10` against 5000 cases materialises **50,000
cycle_items and 50,000 executions**.

`ADD_MODE` picks the arm:
- `all` (default) — the whole selection in one POST, matching today's UI. The arm that can hit the
  30s statement timeout or the 100s proxy limit.
- `chunked` — split into `ADD_CHUNK_SIZE` requests. Run both and compare; that comparison is how you
  decide whether one-shot is still safe at 5000 on the upgraded infra.

### Scenario 3 — 50 concurrent users (the headline)

70% browsing the repository / 20% working inside a run / 10% writing — roughly the product's real
traffic shape. Scenarios 1 and 2 find a slow *query*; this one finds a slow *system*. Two failure
modes only appear here:

- **Pool exhaustion.** 50 users against 20 connections. The 21st in-flight statement waits, then
  503s.
- **One heavy request starving many light ones.** A single unbounded executions read holds a pool
  connection for its whole duration. Watching `op_repo_open_page_duration` degrade while the in-run
  VUs are active is that interference made visible.

Unlike scenarios 1 and 2, a 503 here does **not** abort the run — it is the finding, and aborting on
the first one would destroy the evidence of how bad it gets. It still fails the run.

### Scenario 4 — breakpoint (read-only)

Uses an **open model** (`ramping-arrival-rate`), and that choice is the point. A closed model
silently reduces offered load as the server slows, so saturation hides as reduced throughput and
never shows a breaking point. Arrival-rate keeps sending regardless — like real users — so
saturation shows up as latency then errors.

---

## "How many test cases can the repository hold?"

`s4-breakpoint` finds the **request-rate** ceiling. That is a different question from the
**data-volume** ceiling, and the volume one is answered by re-seeding at increasing sizes and
re-running the same read scenario against each:

```bash
for N in 5000 10000 25000 50000; do
  CASE_COUNT=$N REUSE_EXISTING=true scripts/load-run.sh seed
  VUS=1  CASE_COUNT=$N scripts/load-run.sh s1-repository    # latency vs row count, uncontended
  VUS=50 CASE_COUNT=$N scripts/load-run.sh s1-repository    # and under concurrency
done
```

`REUSE_EXISTING=true` makes each step top the project up to `N` rather than adding `N` more, so the
sequence is cumulative and each stage is one seed of the difference.

Read the resulting curves per operation, because they fail in different shapes and only one of them
is fixed by hardware:

- **`op_repo_open_page`** should stay roughly *flat* — it is `LIMIT 25 OFFSET 0` on
  `idx_testcases_project`, and row count barely touches it. If this climbs with `N`, the index is
  not being used and that is a query-plan problem.
- **`op_repo_page_deep`** will climb *linearly* with `N` no matter what hardware is underneath,
  because `OFFSET 49900` makes Postgres walk and discard 49,900 rows every time. This is the
  operation that defines the practical repository ceiling, and the fix is keyset pagination
  (`WHERE (created_at, id) < (:last_created_at, :last_id)`), not a bigger instance.
- **`op_repo_search`** depends on the V82 trigram indexes continuing to be chosen as `N` grows. A
  sudden step change means the planner switched to a sequential scan.
- **`op_run_open_executions_bytes`** grows *linearly and without bound* — the endpoint has no
  `limit`. At some `N` the response alone exceeds what a browser can hold and parse, and that
  ceiling arrives regardless of how fast the backend is.

The honest answer to "how many can we store" will almost certainly be set by the last two, both of
which are shape problems in the API rather than capacity problems in the infrastructure. Worth
knowing before the upgrade is credited with fixing them.

---

## Running it

```bash
# 0. credentials (gitignored)
cat > load/.env <<'ENV'
BASE_URL=https://app.tesbo.io
TESBO_TOKEN=tsbo_xxxxxxxxxxxxxxxx
PROJECT_ID=<uuid of the dedicated load-test project>
ENV

# 1. seed the fixture — once
scripts/load-run.sh seed

# 2. baseline first, single user. These numbers are what the thresholds should be set from.
VUS=1 scripts/load-run.sh s1-repository

# 3. the scenarios
VUS=50 scripts/load-run.sh s1-repository
RUN_COUNT=10 scripts/load-run.sh s2-run-build
RUN_COUNT=10 ADD_MODE=chunked ADD_CHUNK_SIZE=1000 scripts/load-run.sh s2-run-build   # comparison arm
VUS=50 scripts/load-run.sh s3-mixed-50vu
PEAK_RPS=200 scripts/load-run.sh s4-breakpoint

# 4. clean up — dry run by default
scripts/load-run.sh teardown                          # reports what it would delete
CONFIRM_DELETE=true scripts/load-run.sh teardown      # actually deletes
```

Each run opens its own Terminal window, tees to `load/.run-logs/<scenario>-<stamp>.log`, and writes
a machine-readable summary next to it.

**Baseline before you load-test.** Run everything at `VUS=1` first and set the thresholds in each
script from those numbers. The values currently committed are *proposals*, not measured SLOs — they
are there so a run fails loudly rather than passing silently, and they should be replaced with your
own once you have a baseline on the upgraded infra.

### Authentication

A project-scoped API token (`tsbo_...`), from Project → Settings → API keys. `AuthMiddleware`
consults the bearer only when there is no session cookie and then sets `req.userId` for **every**
route, so a token exercises exactly the same handlers the browser does.

Bearer auth is deliberate, and a session cookie would be the wrong choice: 50 VUs hammering
`POST /api/auth/password/login` would be testing a real user-facing endpoint with its own failure
modes, which is not what any of this is measuring.

---

## Safety: this writes to production

`seed`, `s2`, `s3` and `teardown` create and delete real rows in a real database that holds real
customer workspaces. The guard rails:

- **No defaults for the target.** `requireConfig()` refuses to start without an explicit
  `PROJECT_ID`. There is no discovery step that could wander into a customer's workspace.
- **Use a dedicated project.** Create a throwaway project on production for this. Every scenario
  confines itself to the one `PROJECT_ID` it is given.
- **`scripts/load-run.sh` demands the project id be typed back** before any writing scenario runs
  against `app.tesbo.io`.
- **`abortOnFail`** stops a run once the error rate crosses 5% (25% for the breakpoint test), rather
  than continuing to lean on an API already failing for real users.
- **Ramps, never step loads.** An instant 50 VUs measures connection cold-start as steady-state
  latency, and against production it is simply rude.
- **Tagged fixtures.** Every row created carries `RUN_TAG` (default `k6-load`) in its name.
  `teardown.js` matches strictly on that tag and **dry-runs by default**.
- **Nothing touches Stripe or billing.**

Two things worth deciding before the first production run:

1. **Run it against staging first.** The scripts are environment-agnostic — only `BASE_URL` changes.
2. **Pick a low-traffic window** for `s3` and `s4`. Scenario 3 offers 50 concurrent users against a
   20-connection pool; if it does saturate, it saturates for everyone on that backend, not just for
   the test.

## Cost of a full campaign

At the defaults, against one project: 5000 test cases, 10 runs, 50,000 cycle_items, 50,000
executions, plus whatever `s3`'s writer VUs add. `teardown.js` removes all of it — runs cascade to
their items and executions, and cases go through bulk-delete.
