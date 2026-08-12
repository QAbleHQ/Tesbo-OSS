# E2E coverage waves — tracker

The plan for taking [e2e/](../e2e/) to **90% coverage of both the API and the UI**, wave by wave, and
the shared state several Claude Code sessions need in order to work on it without colliding.

**This file is the source of truth for where the effort stands.** Update it in the same change that
lands a wave, a fix, or a new spec file. If it disagrees with a conversation, believe this file.

Last verified: **2026-08-12**, by re-measuring both counters and running both Playwright projects. All
numbers below are measurements, not estimates, except where explicitly labelled a prediction.

---

## 0. Where 2026-08-12 landed

One day, six efforts (Waves 1–4 and 6, plus the unplanned Screens sweep), none of it committed yet.

| | Start of day | End of day |
|---|---|---|
| API route coverage | 55 / 196 (28%) | **94 / 196 (48%)** |
| UI page coverage | 17 / 51 (33%) | **25 / 51 (49%)** |
| Tests | 194 in 20 files | **674 in 37 files** |
| Spec files | 20 | 37 (+17 new, 4 grown) |
| Utils | 4 | 12 (+8 new) |
| Product defects open | — | **4** |

**Coverage went up 20 points on the API and 16 on the UI, and the suite tripled.** Waves 2, 3, 4 and 6
went from not-started or half-done to done; Wave 5 is now the biggest thing left and nothing blocks it.

The defect count is the more important number, and it is worth stating as arithmetic rather than as one
figure, because red *tests* and distinct *defects* are not the same thing:

| Source | Defects | Status |
|---|---|---|
| §3 numbered bugs 4–9 (attachments) | 6 | fixed, verified green |
| §3 numbered bugs 10, 12–17 (project keys, reports, import/export) | 7 | fixed, **unverified** — stale image |
| §3 numbered bugs 1–3, 11 | **4** | **open** |
| §3 Closed — Wave 1's original ten reds | ~7 distinct fixes | fixed, verified green |
| §3 Closed — Wave 3's three | 3 | fixed, verified green |
| §3 Closed — the Screens sweep's eleven reds | ~9 distinct fixes | fixed, verified green |

So: **17 defects numbered in §3, of which 13 are fixed and 4 are open**, plus roughly 19 more closed
before the numbering started — about 36 distinct defects found in a day, 32 of them fixed. Treat the
totals as approximate and the numbered ones as exact; the Wave 1 and Screens closures were recorded as
red tests, and several tests shared a fix.

The two most severe were both in Wave 2: **anonymous file upload** billed to the workspace's storage
allowance, and an **unauthenticated destructive delete** that removed the stored object as well as the
row. The four still open are one root pattern with a two-line fix.

Two caveats, both load-bearing:

1. **The last run measured a stale stack.** 16 of its 21 reds are fixes that exist in the working tree
   but not in the running images (§5). Those fixes are written and reviewed but **unverified** — under
   [CLAUDE.md](../CLAUDE.md) phase 3 that means unfinished. A rebuild and re-run is the first task of
   the next session, ahead of any new wave.
2. **None of it is committed.** Every file in this day's work is `??` or `M` in `git status`.

---

## 1. The metric

"Coverage" here means two machine-checkable counters, not a feeling:

| Metric | Definition | Start of 2026-08-12 | Now | Target |
|---|---|---|---|---|
| **API route coverage** | distinct controller paths with ≥1 asserting test | 55 / 196 (28%) | **94 / 196 (48%)** | ≥176 (90%) |
| **UI page coverage** | `app/**/page.tsx` routes with ≥1 asserting spec | 17 / 51 (33%) | **25 / 51 (49%)** | ≥46 (90%) |
| **Suite size** | tests reported by `playwright test --list` | 194 in 20 files | **674 in 37 files** | — |
| **Depth** | each covered route scores 4/4: happy path + validation + 401 + cross-tenant | ~15% | not yet measured | ≥90% |

The "start of 2026-08-12" column is measured against `HEAD` (`95f40f8`) — every e2e file added or
grown since is uncommitted, so `git status` and this table are two views of the same day's work. The
denominator moved 197 → 196 because a controller path was removed, not because the count changed
method. Earlier revisions of this file quoted 42 → 73 against 197; that run of the one-liner below
dropped paths whose spec URL contains a `:x` segment, so the older figures undercount by ~12. The
28% → 48% pair is measured with the same corrected pass on both sides and is the one to compare.

Counting method until the Wave 0 script exists:

```bash
# API paths declared by the controllers
for f in $(find Tesbo-Backend-Nest/src -name "*.controller.ts"); do
  grep -oE "@(Get|Post|Put|Patch|Delete)\(\"[^\"]+\"\)" "$f" | sed -E 's/@([A-Za-z]+)\("([^"]+)"\)/\2/'
done | sed -E 's/:[A-Za-z]+/:x/g' | sort -u | wc -l

# API paths referenced by specs
cd e2e && grep -rhoE "/api/[A-Za-z0-9_:\-/\$\{\}\.]+" api ui utils global-setup.ts \
  | sed -E 's/\$\{[^}]*\}/:x/g; s/\?.*$//' | sort -u | wc -l
```

Note the `:` in that second character class — without it every spec URL that interpolates an id is
truncated at the id and the path stops matching its controller declaration.

Both one-liners only see path strings that start at `/api`. Specs that build a URL from a base
variable (`` `${base}/definitions/${id}/options` ``) are invisible to them, so the covered figure is a
**floor**: 94 counted, ~97 actually exercised. The three known false negatives today are the custom
field `options` / `options/:x` / `definitions/reorder` paths, all covered by `custom-fields.spec.ts`.

Route-hit coverage is **not** branch coverage. A route "covered" by one 200-check counts here but
scores 1/4 on depth. Wave 11 is where depth gets closed.

### The 26 uncovered screens

Recorded so the next UI wave doesn't have to re-derive it. Five are out of scope (below), leaving 21:

| Area | Screens | Wave |
|---|---|---|
| Knowledge Base | `/projects/:id/knowledge-base/documents/:id` | 5 |
| Zyra / AI | `/projects/:id/agents/tasks`, `.../tasks/:id`, `.../zyra`, `.../zyra/settings`, `/settings/ai-providers`, `/settings/ai-providers/details` | 9 |
| Integrations | `/projects/:id/settings/integrations/jira`, `.../linear`, `/settings/integrations/jira`, `.../linear` | 8 |
| Execution & runs | `/projects/:id/cycles/:id/execute/:id`, `/projects/:id/cycles/schedule`, `/share/:id` | 2 / 7 |
| The tail | `/`, `/onboarding`, `/verify-otp`, `/invite/:id`, `/invite/:id/register`, `/projects/:id/settings/api-tokens`, `/projects/:id/suites`, `/projects/:id/testcases/:id` | 10 |

`/invite/:id` and `/invite/:id/register` are exercised *through* `api/invitations.spec.ts`'s staged OTP
flows, so the invitation logic is covered even though the screens score zero. Same caveat as the API
counter: this is a floor.

**Deliberately out of scope** (declare it, don't let it happen by accident): live OAuth legs
(`integrations/:provider/auth-url`, real `callback`), superadmin `/api/admin/*` beyond authz, Stripe
write paths (already env-gated), the static `privacy-policy` / `terms-and-conditions` pages,
`integrations/callback`, and `/setup` once a first admin exists.

---

## 2. Wave status

| # | Wave | Status | Files | Tests | Red | Paths left |
|---|---|---|---|---|---|---|
| 0 | Harness (coverage script, fixture factories, fake AI server) | **partial** — 2 of 4 items done | 12 utils (8 new) | — | — | — |
| 1 | RBAC, members, invitations, project access | **specs complete** — awaiting product fixes 1–3 | 5 | 96 | 3 open | — |
| 2 | Attachments & storage | **API done and green** — UI half + 4 gaps pending | 1 | 25 | 0 | 2 |
| 3 | Custom fields | **done** — API + UI, 3 product fixes landed | 3 | 81 | 1 open (bug 11) | — |
| 4 | Import / export | **done** — API + the import wizard UI, 4 product fixes landed | 2 | 37 | 8 stale | — |
| 5 | Knowledge Base v2 — **biggest single win left** | not started | — | — | — | 28 |
| 6 | Reports, analytics, dashboards | **API done** — `reports-ui` tenant kind claimed, spec not written | 1 | 55 | 4 stale | 6 |
| 7 | Execution bulk ops, schedules, share links | not started | — | — | — | 5 |
| 8 | Integrations (Jira, Linear) — **needs a product change first** | blocked | — | — | — | 21 |
| 9 | Zyra, AI, RAG, MCP | not started | — | — | — | 23 |
| 10 | The tail (notifications, activity, API keys, admin, onboarding UI) | not started | — | — | — | 14 |
| 11 | Cross-cutting depth (boundaries, pagination, cascades, concurrency, UI error paths) | not started | — | — | — | — |
| — | **Screens** (nav, projects list, project dashboard, theme) — ran alongside the numbered waves | **done** — 11 product fixes landed | 5 | 187 | 1 stale | — |
| — | Regressions found while building the above (`workspaces`, `project-keys`) | **done** — 2 product fixes landed | 2 | 8 | 3 stale + 1 spec defect | — |

**"Red" means two different things and the distinction matters.** *Open* is a product bug with no fix
written — §3's table. *Stale* is a fix that exists in the working tree but not in the running Docker
image, so the spec is red on the deployed stack only; those are §3's second table, and they clear on a
rebuild rather than on new work. On 2026-08-12 there were **4 open, 16 stale, and 1 spec defect** — so
the honest reading of the day is 4 real reds, not 21.

"Paths left" is uncovered controller paths in that area, from the §1 recount — 102 uncovered in
total, of which ~99 are real. Wave 5 alone is 28 of them.

"Paths left" is uncovered controller paths in that area, from the §1 recount — 102 uncovered in
total, of which ~99 are real. Wave 5 alone is 28 of them.

Ordering is by risk × unblocking, not by size. Wave 8 cannot start until the Jira/Linear base URLs
become configurable — they are hardcoded to `api.atlassian.com` / `api.linear.app`, so no fake
upstream can be pointed at them. Wave 5 is now the obvious next move: it is the largest remaining
block and nothing gates it.

The **Screens** row has no number because it wasn't in the original plan — it grew out of chasing the
theme sweep across every page and stayed because it was finding product bugs (§3 Closed lists eleven).
It covers `ui/navigation.spec.ts`, `ui/projects-list.spec.ts`, `ui/project-dashboard.spec.ts`,
`ui/theme.spec.ts` and the `DSH-A-*` block added to `api/projects.spec.ts`, on `utils/screens-tenant.ts`.

### Wave 0 — what exists and what still doesn't

Utils added today: `rbac-tenant.ts`, `screens-tenant.ts`, `psql.ts`, `password.ts`, `uploads.ts`,
`csv.ts`, `seed.ts`, `reports-fixture.ts` — joining `env.ts`, `otp.ts`, `billing-db.ts` and
`stripe-webhook.ts`, which were already there.

Still missing:

1. `e2e/scripts/coverage-report.ts` — replaces the shell one-liners above, prints the gap table, and
   fails CI below a ratcheting threshold. **Most valuable remaining item**: with several sessions
   adding specs, nobody can currently tell where coverage stands, and the one-liner has now been
   wrong twice (the `:` character class, and the base-variable blind spot in §1).
2. ~~`utils/seed.ts`~~ — **done**. Bulk-seeds cases / runs / executions, with `backdate()` for the
   trend windows Wave 6 needed and `softDeleteExecutions()` for the soft-delete paths.
3. `utils/fake-ai-server.ts` — a local OpenAI-compatible server, wired in through
   `workspace_ai_keys.base_url`. Unblocks Wave 9 with no live AI spend.
4. Suite ergonomics — `@smoke`/`@full` tags, per-area npm scripts, CI sharding, per-file timeout
   overrides. **Now the second most valuable item**: the suite is 674 tests, the api and ui projects
   have to be run separately to get a trustworthy number, and a full run is long enough that people
   quote partial ones.

### Wave 1 — done

`api/rbac.spec.ts`, `api/invitations.spec.ts`, `api/project-access.spec.ts`,
`api/workspace-setup.spec.ts`, `ui/members.spec.ts`.

Covers the role × action matrix, the full invitation lifecycle including the staged OTP registration
flows, per-project access grant/revoke, first-workspace onboarding, and workspace analytics.

Findings worth keeping:

- `/settings/members`, `/settings/project-access` and `/projects/:id/members` are **redirect stubs**.
  The real screens are `/settings?tab=members` (`components/settings/MembersTab.tsx`) and
  `/projects/:id/settings?tab=members`.
- `/api/workspace/project-access` has **no frontend consumer at all** — project scoping is done with
  checkboxes in the invite modal.
- Workspace settings **redirects** a `qa_engineer` to `/projects` rather than rendering read-only.
- `kbRequireOwnerOrManager` guards exactly three operations — restore folder / document / file. It is
  a restore-from-trash gate, **not** a general KB write lock.
- Ownership cannot be transferred through the API: promotion to `owner` is refused outright.

**Pending on Wave 1:**

- [ ] **Product fixes for bugs 1–3** in §3. The specs are written and red; nothing to add on the test
      side once they land.
- [ ] `GET /api/projects/:id/members` is only ever exercised *through the UI*. The path counts as
      covered but scores 1/4 on depth — no direct API assertion on the roster payload, and no
      cross-tenant probe.
- [ ] Depth axes deferred to **Wave 11**, not forgotten: column-length boundaries on the invite email
      and member name, pagination of the member roster and the invitation list, and the concurrency
      case where two owners edit membership at the same time. (One stale-roster race *is* covered, in
      `ui/members.spec.ts`.)
- [x] ~~`ui/project-access.spec.ts`~~ — dropped on purpose. The route is a redirect stub and the
      access-matrix endpoint has no frontend consumer, so there is no screen to test.

### Wave 2 — API done and fully green, UI pending

`api/attachments.spec.ts` (25) + `utils/uploads.ts`. Covers upload / list / download / delete on
execution and bug evidence, filename and content-type edges, and the plan storage ceiling.

**All seven reds are now green** — bugs 4–9 were fixed in product code (see §3 Closed). What remains
on this wave is new coverage, not waiting.

The storage accounting is correct and well covered: bytes appear in `/api/billing/usage`, the Launch
500MB ceiling refuses with "Upgrade to Pro", the Pro 5GB ceiling points at support instead, and
deleting frees the space.

**Pending on Wave 2:**

- [x] ~~Product fixes for bugs 4–9~~ — landed and verified green (§3 Closed).
- [ ] **The UI half**: attaching evidence from the execute page and from the bug detail screen. No
      longer split by dependency — the upload gates have landed, so both the legitimate-member happy
      path (attach → appears → download → delete) **and** the refusal paths (is the control hidden for
      a non-member? what does a 403 render?) can be written now. `/projects/:id/cycles/:id/execute/:id`
      is one of the 26 uncovered screens in §1.
- [ ] **`GET /api/bugs/:id` returns an `attachments` array** (`legacy.service.ts:2822`) and that is the
      read path the bug screen actually uses — never asserted. `attachments.spec.ts` checks the DB row
      and the download endpoint, so an attachment could upload fine and still be missing from the bug
      record without a single test noticing.
- [ ] **The storage warning ladder is untested.** `maybeWarnStorage` emails the owner at 80%, 95% and
      100% (`STORAGE_WARN_THRESHOLDS = [100, 95, 80]`), recording the highest threshold sent in
      `organizations.storage_warned_pct` and *lowering it again* when usage drops so a workspace that
      clears space and refills gets warned afresh. None of that ladder, the once-per-threshold
      guarantee, or the reset behaviour is covered — only the hard refusal at the ceiling is.
- [ ] **Only the local-disk storage driver is exercised.** With `STORAGE_DRIVER=s3` the download
      handler takes a different branch entirely — a 302 to a presigned URL
      (`if ("redirectUrl" in access)`) rather than streaming bytes — and that branch has never run in
      a test. Worth at least one case against MinIO before trusting S3 deployments.
- [ ] KB file upload / download / preview share this storage layer and these limits, but are assigned
      to **Wave 5** with the rest of Knowledge Base v2. Flagged here so the overlap is deliberate.

Not covered on purpose: the real `MAX_UPLOAD_SIZE` boundary (100MB default) — not viable to push
through HTTP per run. A 1MB file stands in.

### Wave 3 — done (2026-08-12)

`api/custom-fields.spec.ts` (44), `api/custom-field-values.spec.ts` (24), `ui/custom-fields.spec.ts`
(13). New tenant kinds: `custom-fields`, `custom-field-values`, `custom-fields-ui`.

All 11 paths of `custom-fields.controller.ts` are covered, plus
`POST /api/projects/:id/testcases/:id/duplicate` — 12 newly-covered API paths — and the
`/projects/:id/settings/custom-fields` screen. Coverage spans definition CRUD across all seven field
types, per-type config validation, the option lifecycle, reorder, the archive/delete split, value
validation and defaults, required enforcement, list filtering across every operator, CSV export, the
role matrix, and the Pro gate including the grace window.

**Three product bugs found and fixed** (see §3 Closed) rather than left red — each was a malformed
input or a missing scope check reachable from the URL bar.

Findings worth keeping:

- **The Pro gate is asymmetric on purpose, and the tests pin both halves.** Reading definitions and
  values is never gated, so a downgraded workspace keeps seeing what it captured. Writing splits by
  caller: the dedicated `PUT .../custom-field-values` throws the paywall 403, while the same writer
  invoked from `createTestCase`/`updateTestCase` runs in `skip-if-disabled` mode and silently
  no-ops, so ordinary test-case work on a Launch workspace is never collateral damage.
- **A required field is enforced on every save of an existing test case**, not just on the ones that
  mention it: `updateTestCase` always calls the value writer, so making a field required retroactively
  blocks the next edit of every test case that lacks a value. Deactivating the field is the escape
  hatch — an inactive required field doesn't block, but still accepts a value if one is offered.
- **Archived ≠ inactive.** Archived is one-way (no reactivation), read-only for config and options,
  refuses new values, keeps existing ones, is excluded from the reorderable set, and frees its name
  for reuse (the unique index is partial: `WHERE status <> 'archived'`).
- `deleteDefinition` refuses any field with recorded values (409 `FORCE_ARCHIVE`); archiving is the
  offered alternative and deliberately keeps the values.
- The settings screen decides `canManage` from **project** membership (`listProjectMembers`), not
  workspace role — a workspace owner who isn't a project member is shown the read-only message.
- Definition ids are the client's own input on the value route, so the option ids in `config` are
  what a value stores — a rename is free, but an option id is load-bearing and never regenerated.

**Pending on Wave 3:**

- [ ] **Bug 11** in §3 — the one red test. Not fixable inside this wave: it is the shared
      `listTestCases` gap, whose siblings are pinned by `authorization.spec.ts`'s `test.fail()`.
      Fixing `list`/`get`/`update`/`delete` together also means editing that file, which belongs to
      whoever owns the authorization sweep.
- [ ] **The XLSX export** carries the same `cf_` columns as CSV (`sendWorkbook`) and is untested —
      only the CSV branch is asserted. Wave 4 owns import/export; flagged here so the overlap is
      deliberate.
- [ ] **Import does not map `cf_` columns back to values.** `ImportTestCasesModal` reads the active
      definitions and builds `customFieldValues` client-side, so a CSV exported with custom fields
      and re-imported through the API alone loses them. Worth confirming as intended before covering.
- [ ] **`buildListFilterSql` deliberately takes no user context** (its own comment says so) because
      `listTestCases` has none — the filter path is only as safe as bug 11.
- [ ] Depth deferred to **Wave 11**: `config` JSONB size limits, a definition count ceiling per
      project (there is none today), and the concurrency case where two managers reorder at once.

### Wave 4 — done (2026-08-12)

`api/import-export.spec.ts` (26) and the "test case import wizard" block added to
`ui/testcase-import.spec.ts` (11). Tenant kinds: `import-export`, `import-export-ui`. Utils: `csv.ts`.

Covers CSV and XLSX export of test cases, the run export, the import template, the server-side
import routes, and the browser wizard end to end: the column auto-mapping other tools' exports need,
a header row found below leading junk rows with errors numbered by file line, the Title-column
requirement, duplicate skipping both against existing titles and within the file, suite plus
component-subfolder creation and reuse on a second import, step splitting into actions with expected
results, the worksheet picker for a multi-sheet workbook, the unreadable-file path, and the export
menu's four links.

Findings worth keeping:

- **The import is a client-side feature.** `ImportTestCasesModal` parses the file in the browser and
  calls `createTestCase` per row; the server's `previewImport`/`executeImport` are stubs that return
  `{uploadId:"local-upload", totalRows:0}` and `{imported:0}` without reading the body. That is why
  the wizard coverage is UI-level and the API-level import coverage is a bug report (§3 bug 15).
- **CSV and XLSX export disagree on an empty project.** CSV emits its header row; the workbook
  branch derives its header from the first row's keys, so with no rows the file opens blank (bug 17).
- The run export is `/api/cycles/:id/export/csv` — on the cycle, not under `/projects/:id/`, which is
  why it has none of the project-scoped guards its siblings have (bug 16).

**Pending on Wave 4:**

- [ ] **Product fixes for bugs 14–17** in §3 — six red tests, all authorization or contract, none of
      them needing test-side work once the product lands.
- [ ] **Import does not map `cf_` columns back to values** — carried over from Wave 3 and now
      confirmed: the wizard builds `customFieldValues` client-side from the active definitions, so a
      CSV round-tripped through the API alone loses them. Still worth confirming as intended before
      covering.
- [ ] The XLSX **import** path is covered through the wizard but not at the API level, because there
      is no API-level import to cover. It becomes testable if bug 15 is fixed rather than deleted.

### Wave 6 — API done (2026-08-12)

`api/reports.spec.ts` (55), on `utils/reports-fixture.ts` and `utils/seed.ts`. Tenant kind `reports`.

Covers the project analytics counters, execution report grouping, the traceability matrix, the
repository summary, the reports overview, AI insights, trends, the per-run report summary, and
cross-endpoint consistency — that is, the same number read two ways must agree.

Findings worth keeping:

- **The cross-endpoint consistency block is the valuable half.** Individually each report endpoint
  looks right; the disagreements only surface when two are asserted against one seeded fixture.
  This is where the `Retest` divergence in §5 "Worth checking" was found.
- Trend windows need controlled timestamps, which is what forced `utils/seed.ts`'s `backdate()` into
  existence. Wave 0 item 2 closed as a side effect.
- `project-keys.spec.ts` and `workspaces.spec.ts` both came out of building this fixture, not out of
  the reports themselves — seeding many projects with long similar names is what exposed bug 10.

**Pending on Wave 6:**

- [ ] **Product fixes for bugs 12–13** in §3 — four red tests: the whole report surface authorizes
      nothing, and one endpoint 500s on a malformed id.
- [ ] **The UI half.** `reports-ui` is already claimed in `RbacTenantKind` but `ui/reports.spec.ts`
      does not exist. `/projects/:id/reports` and `/projects/:id/dashboard` are the screens; the
      dashboard is already partly covered by the Screens work, the reports page is not.
- [ ] **Insights still counts `Retest` as executed** — see §5 "Worth checking". Deliberately left
      alone here: no spec drives the five report denominators, and changing them would move numbers
      that `reports.spec.ts` now asserts as green.
- [ ] The six `tesbo-reports/*` paths (the external reporting ingest) are untouched and unassigned.
      They are not the same surface as this wave's `reports/*`; they need a home in Wave 10.

### Screens — done (2026-08-12)

`ui/navigation.spec.ts` (38), `ui/projects-list.spec.ts` (46), `ui/project-dashboard.spec.ts` (34),
`ui/theme.spec.ts` (49), and the `DSH-A-*` block in `api/projects.spec.ts` (20 of its 27), on
`utils/screens-tenant.ts`. Not a numbered wave — see §2.

**Eleven product bugs found and fixed** (see §3 Closed). This is the strongest evidence in the effort
so far that sweeping breadth-first across screens finds more than deepening one area: the theme sweep
alone produced two contrast defects, a `localStorage` crash, and the unlayered-`a`-colour trap.

Findings worth keeping:

- **`ui/theme.spec.ts` is 49 tests, not 18** — `THM-13`/`THM-14` iterate 34 pages inside one test
  each and the file parametrises light and dark. Grepping for `test(` undercounts every parametrised
  file in the suite; use `playwright test --list`.
- The theme sweep is the suite's slowest file and the first to tip over under parallel load, which is
  what surfaced the `/activity` page-performance question in §5.

---

## 3. Open product bugs the suite is red on

These tests assert the behaviour the product **should** have. They are red because it doesn't.

**Do not turn them green by weakening them** — no `test.skip`, no `test.fail()`, no loosened matcher,
no widened timeout. They clear when the product is fixed. (`api/authorization.spec.ts` predates this
rule and uses `test.fail()` for its known gaps; new specs don't.)

Four are still open. Verified red against the running image on 2026-08-12:

| # | Bug | Where | Red test |
|---|---|---|---|
| 1 | `createSuite` / `createPlan` / `createCycle` take **no caller at all** — their controller methods never receive `@Req()`, so a workspace member with no project access can write into any project by id | `legacy.controller.ts:281`, `:353`, `:403` | `rbac.spec.ts` "a workspace member with no project access cannot write into the project" |
| 2 | …and so can a caller with **no session at all** | same | `rbac.spec.ts` "an anonymous caller cannot write into a project" |
| 3 | `analytics()` counts archived projects — `FROM projects` with no `archived_at` filter, unlike `testCaseCount` which uses the soft-delete-aware `testcases_active` view | `legacy.service.ts:3288` | `workspace-setup.spec.ts` "workspace analytics counts a new project, and stops counting an archived one" |
| 11 | `listTestCases` takes **no caller at all** — no `@Req()` on the route — so an anonymous caller can read any project's test cases, and each row now carries a `customFieldValues` map, so the custom field data goes with them | `legacy.controller.ts:295` | `custom-field-values.spec.ts` "the test case list does not hand a project's custom field values to an anonymous caller" |

All four are the same root pattern (3 excepted): **the controller method never takes `@Req()`**, so
there is nothing to authorize against. The fix shape is two lines per handler:

```ts
const uid = this.requireUser(userId);
await this.requireProjectAccess(uid, projectId);
```

Bugs 1 and 2 are one fix, and it is now the **last** instance of the pattern in the codebase — every
other handler that had it was fixed today. Worth taking as a single change rather than a wave item.

### Fixed in the working tree, not yet verified by a run

These landed today **after** the running backend image was built (12:48). Their specs are still red on
the deployed stack, and the fixes are unverified until the image is rebuilt. Do not count them as
either open bugs or closed ones — see §5.

| # | Bug | Fix in the working tree |
|---|---|---|
| 10 | A derived project key colliding with an existing project surfaced the unique-constraint violation raw — a 500. `projectKey()` truncates to 16 chars, so two names sharing a long prefix collide, and a re-run against the persistent volume collided with itself | `insertProjectWithUniqueKey` + `nextFreeProjectKey` (`legacy.service.ts:1804`): the next free numeric suffix, falling back to 3 random bytes, inside the transaction that catches the violation |
| 12 | The whole report surface took no caller — anonymous read, any project by id, any tenant | six new `*ForUser` methods (`executionReportForUser`, `requirementMatrixForUser`, `repositorySummaryForUser`, `reportsOverviewForUser`, `reportsInsightsForUser`, `reportsTrendsForUser`), and the controller now passes `req.userId` to each |
| 13 | A report endpoint 500'd on `not-a-uuid` | the `isUuid()` guard, via the same `*ForUser` methods |
| 14 | `template()` was project-scoped but authorized nothing and never validated the project id — the only route under `/api/projects/:id/` that answered with no session | now takes `@Req()` and resolves the project |
| 15 | `previewImport()` / `executeImport()` were stubs reporting `{imported:0}` success without reading their body, to any caller | **routes deleted**, with a comment in their place. The import is a client-side feature; the spec offered deletion as the valid fix and that is the branch taken. The dead `previewImport`/`executeImport` helpers in `Tesbo-Frontend/lib/api.ts` go with them |
| 16 | `exportCycleExecutions` — the whole run, including linked defect keys and URLs, readable by anyone holding a cycle id, with no session, from any workspace | `requireUser` + `isUuid` + `requireProjectAccess` (`legacy.service.ts:2733`), and an unresolvable run id is now a 404 instead of a header-only 200 |
| 17 | The XLSX export of an empty project produced a workbook with **no header row** — a blank sheet with nothing to fill in — while the CSV export of the same project emitted its headers | `sendWorkbook` takes an explicit `headers` list, since `json_to_sheet` otherwise derives columns from the first row's keys |

### Not a product bug — a spec defect

`api/workspaces.spec.ts` "same-named workspaces are distinct records, each owned by its creator"
asserts that `env.orgName` ("E2E Smoke Org") is owned by **exactly two** accounts, install-wide. It
counts owners across the whole database, so every re-run against the persistent volume adds one and
the assertion drifts (it read 3 on 2026-08-12). This breaks §4's idempotency rule — the fixture the
assertion depends on is shared and unbounded, not uniquely named.

It is listed here rather than in the table above because the product is behaving correctly: the point
the test is making (ownership is per-workspace) holds. The fix belongs on the test side and is the
narrow case §3's rule allows, because the *expectation itself* is wrong — it should scope the query to
the two accounts this spec created rather than to a name any other spec may also use. Left in place
for whoever owns that file; do not "fix" it by relaxing the number.

### Closed

**2026-08-12 — Wave 2's seven reds (bugs 4–9)**, all fixed in `legacy.service.ts` and **verified
green**: `api/attachments.spec.ts` is 25/25. `uploadBugAttachments` (anonymous upload billed to the
workspace's allowance) and `deleteBugAttachment` (unauthenticated destructive delete of the stored
object as well as the row) were the two most severe findings in the effort; both now take
`requireUser` + `requireProjectAccess`, as do `uploadExecutionAttachments`,
`listExecutionAttachments`, and the download path, with `isUuid()` closing the malformed-input 500s.

**2026-08-12 — Wave 3's three reds**, all fixed in `custom-fields.service.ts` as they were found:

| Symptom | Fix |
|---|---|
| `definitions/not-a-uuid` (and the same on update / status / options / delete, and on the value routes) answered a URL typo with a **500** — the failed uuid cast surfacing raw | `isUuid()` is now exported from `legacy.service.ts` and guards every id that reaches a uuid column here; a malformed id gets the same 404 as a well-formed one that doesn't exist |
| A field name longer than `VARCHAR(160)` reached Postgres and **500**'d | `requireFieldName()` refuses > 160 characters with a 400, on create and update |
| `PUT .../testcases/:id/custom-field-values` checked project access but **never checked the test case belonged to that project** — a caller could name any test case in the deployment, including another workspace's, and write values onto it | in `enforce` mode the writer now resolves the test case against the project first, 404 otherwise. `skip-if-disabled` callers are unaffected: `createTestCase`/`updateTestCase` resolved the row themselves |

Wave 1's original ten reds were fixed in `legacy.service.ts` / `legacy.controller.ts`: a new
`parseRole()` (rejects unknown roles rather than collapsing them to `qa_engineer` the way
`normalizeRole()` does), a caller-role check on `addWorkspaceMember`, role checks on
`updateProjectForUser` / `deleteProjectForUser`, `addProjectMember` resolving its target through
`organization_members` instead of bare `users`, a module-level `isUuid()` guard, and
`workspaceProjectAccess()` replacing the controller's hard-coded `projectRoles: {}`. The `isUuid()`
guard also cleared the pre-existing `DSH-A-16`.

**2026-08-12 — the eleven projects-list / theme / dashboard reds.** All fixed in product code:

| Test | Fix |
|---|---|
| `PRJ-C-23` | `createProject` refuses a `qa_engineer`; the rule existed only in the React component |
| `DSH-A-10` | `parseBugSeverity()` returns a 400 naming the field instead of letting `bugs_severity_check` surface as a 500 (create *and* update) |
| `DSH-A-19` | `Retest` counts as untested in `listCycles`/`planRuns`/`planProgress`, and leaves the dashboard's executed denominator — a case sent back for retest has no settled result |
| `PRJ-D-09`, `PRJ-D-28` | the card reports the most recent *executed* run, as passed-over-executed, matching the dashboard |
| `PRJ-D-10` | the card uses the run's own `blocked` count instead of `total − passed − failed` |
| `PRJ-D-22` | each per-project stat call is caught individually, so one 500 degrades one card rather than blanking the list |
| `PRJ-C-16` | closing the create modal clears the draft |
| `THM-08` | new `lib/storage.ts`; every unguarded `localStorage` call routes through it |
| `THM-13`, `THM-14` | `--ink-300`/`--ink-400`/`--muted-soft` retuned against the darkest surface they sit on; text uses the `-foreground` tokens, not the fill tokens (which are tuned to *carry* white text); avatar palette consolidated into `lib/avatarColors.ts` |

One spec was rewritten rather than fixed: **`DSH-A-20`** pinned the exact `Retest` divergence
`DSH-A-19` reports from the other side — zero in every bucket but `passed`, and a dashboard reading
50%. Fixing one required changing the other, so it now asserts the two readings agree. That is the
only spec edit in this change, and it is the narrow exception §3's rule allows: the expectation
itself was documenting the defect.

---

## 4. Conventions any new spec must follow

Beyond [CLAUDE.md](../CLAUDE.md)'s four phases:

- **One disposable tenant per spec file.** `fullyParallel` is false so tests inside a file serialise,
  but files still run concurrently across workers. Two files sharing a workspace interleave their
  membership writes and fail each other at random. Add a kind to `RbacTenantKind` in
  [utils/rbac-tenant.ts](../e2e/utils/rbac-tenant.ts). Read the `RbacTenantKind` union there for the
  current list rather than trusting a copy here — several sessions add to it at once.
- **Clear `storageState` explicitly** when building an API or browser context.
  `request.newContext()` inherits `playwright.config.ts`'s account-A session, which silently makes an
  "anonymous" caller authenticated (a 200 where the test wanted a 401). `loginAs()` and
  `anonymousContext()` already do this.
- **Never pipe SQL into `docker compose exec -T`.** [utils/psql.ts](../e2e/utils/psql.ts) passes SQL
  as argv via `execFileSync` for a reason: with several workers shelling out at once the piped stdin
  can be dropped, and psql then exits 0 having run nothing. Writes silently no-op and reads silently
  return `""`, so fixtures appear applied when they aren't and the failure lands in an unrelated
  test, differently on each run. Use `exec` / `scalar` / `column` from that module — don't add a
  second transport.
- **Teardown must not depend on the endpoint under test.** Clean up through Postgres when the delete
  path is itself being asserted.
- **Arrange through Postgres when the API gate is the thing being tested** — e.g. `setProjectRole`
  exists so a fixture doesn't depend on the permission check it's verifying.
- **Assert on persisted state, not just the response** — the DB row or a follow-up read, not only a
  toast.
- Uploads: build bodies in memory with `FormData` + `Buffer`
  ([utils/uploads.ts](../e2e/utils/uploads.ts)). `FilesInterceptor("files", 10)` needs a repeated
  field name, which Playwright's object form of `multipart` cannot express. No committed binaries.

---

## 5. The last run, and what is red in it

**Run the two projects separately.** A single `npx playwright test` covering all 674 has been killed
near the end (~test 470, exit 144, no summary) more than once; per-project runs finish reliably and are
the only numbers worth quoting.

Latest run, 2026-08-12, against the deployed stack:

| Project | Result | Wall clock |
|---|---|---|
| `--project=api` | 18 failed, 409 passed, 3 skipped | 2.2m |
| `--project=ui` | 3 failed, 241 passed | 5.1m |
| **total** | **21 failed, 650 passed, 3 skipped** | 7.3m |

### 16 of those 21 are stale-image artifacts, not failures

**The running containers were built before the day's later product fixes.** The backend image dates
from 12:48 and the frontend from 13:10, while `legacy.service.ts` was last edited at 18:24 and
`ImportTestCasesModal.tsx` at 17:40. Everything fixed after lunch is therefore red on the deployed
stack and correct in the working tree:

| Red | Count | Fixed in the working tree by |
|---|---|---|
| `api/import-export.spec.ts` | 6 | bugs 14–17 |
| `api/reports.spec.ts` `RPT-A-49/51/52/53` | 4 | bugs 12–13 |
| `api/project-keys.spec.ts` `PKY-A-01/02/03` | 3 | bug 10 |
| `ui/testcase-import.spec.ts` × 2 (auto-map, worksheet picker) | 2 | the wizard work itself |
| `ui/projects-list.spec.ts` `PRJ-C-23` | 1 | `createProject` refusing a `qa_engineer` (`legacy.service.ts:1783`) |

**This has to be re-run against a rebuilt image before any of it can be called done.** Per
[CLAUDE.md](../CLAUDE.md) phase 3, a fix that has never run is not a deliverable — the expected result
after `scripts/deploy-and-test.sh` is **5 failed** (the 4 open bugs plus the spec defect), but that is
a prediction, not a measurement, and must not be written into this file as one.

The lesson worth keeping: **check the image build time before reading a red run.**

```bash
docker image inspect tesbo-test-manager-private-backend --format '{{.Created}}'
docker image inspect tesbo-test-manager-private-frontend --format '{{.Created}}'
```

If either predates your last edit to the code under test, the run is measuring yesterday.

### The 5 that are real

- `api/rbac.spec.ts` × 2 — §3 bugs 1–2
- `api/workspace-setup.spec.ts` × 1 — §3 bug 3
- `api/custom-field-values.spec.ts` × 1 — §3 bug 11
- `api/workspaces.spec.ts` × 1 — the spec defect in §3, not a product bug

`ui/full-scenario.spec.ts`, `ui/theme.spec.ts` `THM-08`/`THM-13`/`THM-14`, `api/projects.spec.ts`
`DSH-A-10`/`DSH-A-19`, and the whole of `api/attachments.spec.ts` were all on the pre-existing-failure
list and are now **green**. A failure in any of them is a regression, not a known red. There is no
longer a standing "known failures" list beyond the five above.

### Contention flakes — re-run with `--workers=1` before believing them

These pass on their own and only fall over in a full parallel run. They are timing, not behaviour:

| Test | Alone | Budget |
|---|---|---|
| `ui/theme.spec.ts` `THM-12 workspace activity` (light and dark) | ~25s | 30s |
| `ui/theme.spec.ts` `THM-13` | ~66s | 90s (`test.slow()`) |
| `ui/navigation.spec.ts` `NAV-B-06/09` | 1.9s | 30s |
| `ui/testcases-pagination.spec.ts` | 1.9s | 30s |

Do **not** widen these timeouts — that is the §3 rule, and it would hide the real question below.

**None of them flaked in the 2026-08-12 per-project runs**, which is itself the finding: splitting api
from ui halves the concurrent load, and these four stop tipping over. That is a second reason to run
the projects separately, beyond the truncated-run problem.

### Worth checking

Findings that no spec currently forces, recorded so they aren't lost:

- **`/activity` is slow to settle.** It needs ~25s of a 30s budget just to reach `networkidle`, which
  is what makes `THM-12 workspace activity` the first thing to tip over under load — and it drags
  `THM-13`'s 34-page sweep toward its cap too. Nothing in the page polls and no theme change touched
  it, so this is a page-performance question standing on its own, not a theme defect.
- **Insights still counts `Retest` as executed.** The `Retest`-is-unsettled fix (§3 closed) was scoped
  to `listCycles` / `planRuns` / `planProgress` and the project dashboard's pass rate. The five
  report denominators in `legacy.service.ts` (`passRateSeries`, `suiteHealth`, coverage, untested-P1,
  flaky — all `e.status <> 'Untested'`) were deliberately left alone: no spec drives them, and
  changing them would move green `reports.spec.ts` numbers. Insights and the dashboard therefore
  disagree about a run containing a `Retest`.
- **A link's colour cannot be set with a utility class.** `globals.css` carries an unlayered
  `a { color: var(--accent-light) }`, and unlayered CSS outranks every cascade layer — so it beats
  any `text-[…]` on an anchor regardless of specificity. This cost an hour during THM-13: the class
  was correct in the source and in the built CSS, and the computed colour was still the old token.
  Change the rule, not the call site.
- **Two contrast defects the sweep only catches by luck.** `PriorityBadge` carried literal hexes that
  never followed the theme (three of four at 1.96–2.23:1 in dark), and the avatar palette's green and
  amber failed white text at 3.59:1 and 3.07:1. Both are fixed, but neither was *deterministically*
  caught: a badge only appears if the seeded data has that priority, and the avatar swatch is a hash
  of the user id. A spec that renders all four priorities and all six swatches would close the gap.

- **`playwright test --list` is the only trustworthy test count.** Grepping for `^\s*test(` undercounts
  every parametrised file: `ui/theme.spec.ts` greps as 18 and lists as 49, `api/projects.spec.ts` as 32
  and 27. Earlier revisions of this file quoted grep numbers; the §1 and §2 figures are now `--list`
  ones throughout.

Two further cautions:

- **Several sessions work this repo at once.** `e2e/ui/*.spec.ts` files have been seen changing
  mid-run, producing failures at line numbers that no longer exist. Re-run a file on its own before
  believing its result. `ListAgents` shows who else is active. This is also why nobody should rebuild
  the stack without asking — the backend container was restarted by another session mid-run on
  2026-08-12.
- **Full-suite runs have been killed near the end** (~test 470, exit 144, no summary) more than once.
  Per-file, per-area, and per-project runs are the reliable signal; don't quote a number from a
  truncated run.

---

## 6. Running it

```bash
cd e2e
# one project at a time — this is the recommended way, see §5
API_BASE_URL=http://localhost:1021 WEB_BASE_URL=http://localhost:1020 \
  npx playwright test --project=api        # 430 tests, ~2.2m
API_BASE_URL=http://localhost:1021 WEB_BASE_URL=http://localhost:1020 \
  npx playwright test --project=ui         # 244 tests, ~5.1m

# one file at a time
API_BASE_URL=http://localhost:1021 npx playwright test api/attachments.spec.ts --project=api

# the real count, per file — never grep for `test(`
API_BASE_URL=http://localhost:1021 WEB_BASE_URL=http://localhost:1020 npx playwright test --list
```

**Check the images first.** If either predates your last edit to the code under test, the run measures
old code and its reds mean nothing (§5):

```bash
docker image inspect tesbo-test-manager-private-backend  --format '{{.Created}}'
docker image inspect tesbo-test-manager-private-frontend --format '{{.Created}}'
```

Rebuild with [scripts/deploy-and-test.sh](../scripts/deploy-and-test.sh) — but **ask first**: several
sessions share this stack and a rebuild mid-run invalidates someone else's results.

The DB-backed fixtures need `docker compose exec postgres psql` to be reachable. Where it isn't,
those suites skip themselves with a reason rather than failing — see `rbacSuiteSkipReason`.

---

## 7. Working across threads

1. **Claim a wave here before starting it** — add your session and the date to the status table.
2. **Don't edit another session's spec files.** Add a new file, or coordinate first.
3. **Update this doc in the same change** that lands the work — wave status, coverage numbers, and
   any new red test in §3.
4. **Record findings, not just tests.** The redirect stubs, the dead `project-access` endpoint, and
   the narrow scope of the KB gate each cost real time to discover.
5. **Re-measure, don't re-quote.** Both counters and the test count have been wrong in this file at
   least once each, always in the optimistic-or-pessimistic direction nobody checked. Re-run the §1
   one-liners and `--list` before you edit a number.
6. **Separate "fixed" from "verified".** A fix in the working tree with a red spec against a stale
   image is neither open nor closed — §3 has a second table for exactly that state, and things left
   there are the next session's first job, not its backlog.

### Next session, in order

1. Rebuild the stack and re-run both projects. Expect 5 red; anything else needs explaining.
2. Fix §3 bugs 1–2 (one change, the last instance of the missing-`@Req()` pattern), then 3 and 11.
3. Fix the `workspaces.spec.ts` idempotency defect.
4. Commit. All of 2026-08-12's work is still uncommitted.
5. Then start Wave 5 — 28 uncovered paths, unblocked, and the largest remaining single win.
