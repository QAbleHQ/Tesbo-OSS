# E2E coverage waves — tracker

The plan for taking [e2e/](../e2e/) to **90% coverage of both the API and the UI**, wave by wave, and
the shared state several Claude Code sessions need in order to work on it without colliding.

**This file is the source of truth for where the effort stands.** Update it in the same change that
lands a wave, a fix, or a new spec file. If it disagrees with a conversation, believe this file.

Last verified: **2026-08-14**, by re-measuring both counters with
[e2e/scripts/coverage-report.ts](../e2e/scripts/coverage-report.ts) and running both Playwright
projects against a freshly rebuilt backend and frontend. All numbers below are measurements, not
estimates, except where explicitly labelled a prediction.

---

## 0. Where 2026-08-14 landed — 100% on both counters

**API path coverage 195 / 195 (100%). UI page coverage 47 / 47 (100%).** Every controller path and
every app-router screen is referenced by at least one asserting spec. 885 tests in 46 files.

Getting from 96% to 100% took one new spec file and three more resolver forms — the split is the point:

| | Start of 2026-08-12 | End of 2026-08-12 | End of 2026-08-14 |
|---|---|---|---|
| API path coverage | 55 / 196 (28%) | 94 / 196 (48%) | **195 / 195 (100%)** |
| UI page coverage | 17 / 51 (33%) | 25 / 51 (49%) | **47 / 47 (100%)** |
| Tests | 194 in 20 files | 674 in 37 files | **885 in 46 files** |
| Product defects fixed | — | ~32 | **+31 (this session)** |

**Two of the last seven "uncovered" API paths were real, five were the instrument.** That ratio is
worth remembering: at high coverage, most of what a counter reports as missing is the counter. The two
real ones were `POST /api/auth/signup/start` and `/verify`, which `global-setup.ts` *exercised* on every
run (a break would fail the whole suite at startup) but which nothing *asserted* — a distinction the
metric's own definition makes and which nothing had been checking. They now have
[api/signup.spec.ts](../e2e/api/signup.spec.ts): 11 tests over email normalisation, the 8-character
password floor, the duplicate-account refusal, a wrong code, an expired code, a correct code with no
pending signup behind it, OTP replay, and the full start → verify → signed-in path.

That file also has to be **frugal**: `signup/start` is IP rate-limited and every worker looks like the
same caller, so its attempts come out of the allowance `api/auth.spec.ts`'s own rate-limit tests need.
It makes exactly two rate-limited attempts, asserts every validation case *before* the limit is
touched (validation runs ahead of `sendOtp`), and clears the IP bucket in both `beforeAll` and
`afterAll` so what it spends is returned.

The denominator moved 196 → 195 because one route was deleted (see bug 24). The UI denominator is 47
rather than 51 because [coverage-report.ts](../e2e/scripts/coverage-report.ts) excludes the four
screens §1 declares out of scope, instead of leaving them to inflate the gap.

### The measurement was wrong, three times over

The single most important thing that happened on 2026-08-14 is that **the counters were not
measuring what they claimed**, and the corrected figure is 15 points higher than the old method
reported even before any new tests were written. [e2e/scripts/coverage-report.ts](../e2e/scripts/coverage-report.ts)
(Wave 0 item 1, previously the "most valuable remaining item") replaced the shell one-liners and
found all three faults:

1. **Query-strip before interpolation-collapse.** `normalizePath` stripped `?…` before collapsing
   `${…}`, and a nullish-coalescing default *inside* an interpolation
   (`` `/api/projects/${projectId ?? tenant!.mainProjectId}/…` ``) contains a literal `?`. Every path
   in such a file truncated to `/api/projects/${projectId` and collapsed into one bucket — a
   107-test Knowledge Base suite measured as **six** covered paths.
2. **Quote-pair scanning.** Matching "every quoted string" pairs quotes in order, and an apostrophe
   in prose (`"…but not someone else's"`) is an unbalanced quote that shifts every subsequent match
   in the file. Fixed by anchoring on `/api`, on a builder's name, or on an interpolation.
3. **Literal-vs-parameter matching.** A spec that writes a concrete value where the route declares a
   parameter (`…/integrations/jira/auth-url` against `…/integrations/:provider/auth-url`) counted as
   uncovered. Now attributed the way a router dispatches: to the **most literal** matching route, so
   one reference cannot mark both a literal route and its `:param` sibling covered.

Three more forms were needed to close the last 4%, all the same class — a URL the resolver could not
follow:

4. **A builder built from another builder's interpolation.** `definitionUrl(id) => \`${definitionsUrl(projectId)}/${id}\``
   starts with neither `/api` nor a bare call, so neither the "template" nor the "wrapper" form saw it.
   That is the shape of every `…Url(id)` helper in the suite.
5. **A builder called with a loop variable.** `for (const path of [...]) … api.get(url(path))` is a
   better test than six unrolled copies, and it was invisible because the argument is an identifier.
6. **A loop variable inside a path**, for the UI counter: `goto(\`/settings/integrations/${provider}\`)`
   collapsed to `/settings/integrations/:x`, which matches no declared page — both providers are
   literal directories in the app router.

The lesson generalises: **a coverage number is a program, and it needs tests of its own.** Six
independent bugs all pointed the same way — pessimistic — which is why nobody caught them by
eyeballing the output.

**So the number is now auditable rather than asserted.** Two guards were added along with the forms,
because "100%" is exactly the claim that most needs checking:

- `npm run coverage:audit` prints every declared route with the spec files that reference it, so a
  covered claim can be traced to a test instead of believed. All 195 resolve to a `.spec.ts`; the two
  that resolved only to `global-setup.ts` are what prompted `api/signup.spec.ts`.
- the report now **always** lists referenced paths that match no declared route. A dangling reference
  is either a resolver bug (an over-count) or a spec calling a route that does not exist, and a tool
  that can only over-count in silence is the thing this file exists to stop.

**Both guards earned their keep immediately.** The audit found the two signup routes credited only by
`global-setup.ts`. The dangling list found 22 fabricated paths — the resolver was stitching assertion
messages onto real prefixes (`${url} should refuse an anonymous upload`) and appending bare ids to
builders whose parameter sits mid-template (`…/custom-field-valuesnot-a-uuid`). Tightening that dropped
the reported figure from a false 100% to a true 98%, which is the more useful number: **three paths had
been credited by an over-match.** Splitting "what `${name()}` resolves to" from "what a call site may
append to" fixed them properly, and 100% now holds with the strict rules in place.

It also found genuine drift: `api/import-export.spec.ts` still posts to
`/api/projects/:id/testcases/import/preview` and `/import`, which §3 bug 15 **deleted**. Its test "the
import routes refuse an anonymous caller" therefore passes because the routes are gone, not because they
are guarded — and its comment still says "Red: previewImport()/executeImport() take no @Req()". A test
that passes for a reason its author did not intend is the failure mode a coverage tool cannot see;
this one is Wave 4's file to fix (§7.2).

Around a dozen benign entries remain in that list — an array-literal base (`"/api/suites"` from a
cleanup loop's `[base, …]`) reads as a path, and a non-appended id leaves a segment out. They credit
nothing, so they cost nothing; if the list ever gets ignored because of them, teach `record()` to track
whether a hit came from a literal and report only those.

### What this session added

| Wave | File(s) | Tests | Product fixes |
|---|---|---|---|
| 5 — Knowledge Base | `api/knowledge-base.spec.ts` (56), `api/kb-files.spec.ts` (26), `api/kb-comments.spec.ts` (25) | 107 | 9 |
| 8 — Integrations | `api/integrations.spec.ts` | 25 | 15 |
| 9 — Zyra / AI / MCP | `api/zyra.spec.ts` | 31 | 12 |
| 10 — The tail | `api/tail.spec.ts` | 20 | 10 |
| 7 — Execution ops | `api/execution-ops.spec.ts` | 17 | 4 |
| — Screens sweep | `ui/screens-sweep.spec.ts` | 17 | — |
| 0 — Harness | `scripts/coverage-report.ts`, `utils/zip.ts` | — | 3 measurement bugs |

**31 product defects fixed and verified green.** The three most serious:

1. **A corrupt PNG uploaded to a knowledge base restarted the API for every user** (bug 19).
   tesseract.js's worker handler does `if (errorHandler) errorHandler(data); else throw Error(data)`,
   and that throw is outside the promise `recognize()` returns — so it landed as an uncaught
   exception and killed the Node process. Observed as 6 container restarts during one test file.
2. **The entire Jira/Linear surface answered anyone** (bug 20). Fourteen handlers took no `@Req()`:
   the mirrored ticket store was readable by an anonymous caller, the project→remote-project mapping
   was rewritable, and `jiraComment`/`linearComment` posted to the customer's real tracker using the
   workspace's stored OAuth token.
3. **Every new workspace's first project had no knowledge base at all** (bug 18).
   `createOrgAndProject` never called `seedKnowledgeBaseDefaults`, which `createProject` does — so the
   project every signup lands in had no root folder, the folder tree 404'd, and creating a folder
   silently made an orphan second root.

## 1. The metric

"Coverage" here means two machine-checkable counters, not a feeling:

| Metric | Definition | 2026-08-12 start | 2026-08-12 end | **Now** | Target |
|---|---|---|---|---|---|
| **API path coverage** | distinct controller paths with ≥1 asserting test | 55 / 196 (28%) | 94 / 196 (48%) | **195 / 195 (100%)** | ≥90% ✅ |
| **UI page coverage** | `app/**/page.tsx` routes with ≥1 asserting spec | 17 / 51 (33%) | 25 / 51 (49%) | **47 / 47 (100%)** | ≥90% ✅ |
| **Suite size** | tests reported by `playwright test --list` | 194 in 20 files | 674 in 37 files | **885 in 46 files** | — |
| **Depth** | each covered route scores 4/4: happy path + validation + 401 + cross-tenant | ~15% | not measured | not measured | ≥90% |

**Measure it with the script, not with a grep:**

```bash
cd e2e
node --experimental-strip-types --no-warnings scripts/coverage-report.ts              # the tables
node --experimental-strip-types --no-warnings scripts/coverage-report.ts --uncovered  # the gap list
npm run coverage         # the tables
npm run coverage:audit   # every route + the specs that cover it
npm run coverage:gate    # exits non-zero below 100% — the CI ratchet
```

The last form exits non-zero below the threshold, which is what a CI ratchet should call. The three
faults it was written to fix are in §0; the shell one-liners it replaced are gone rather than kept as
a second opinion, because two different wrong answers is worse than one.

**`coverage:gate` is now set at 100%**, which is what a ratchet means: a new controller route or a new
screen fails CI until something asserts against it. Lower it in `e2e/package.json` if that turns out to
be too strict for a work-in-progress branch — but lowering it is a decision, whereas drifting down from
90% was an accident waiting to happen.

The figure remains a **floor** in principle: the resolver follows constants, single-argument builders,
builders built out of builders, builders built from another builder's interpolation, and loop variables
over string literals — but not a URL assembled any more indirectly than that. It happens to be exact
today, because `--uncovered` is empty and every route audits back to a spec. **If a route ever appears
in `--uncovered` that you know is tested, the resolver needs another form; adding one is cheaper and
more honest than unrolling a loop in a spec to satisfy a tool.**

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

### The 2 uncovered screens

Down from 26. [ui/screens-sweep.spec.ts](../e2e/ui/screens-sweep.spec.ts) opened the 21 that nothing
was visiting: the suites list, a test case's detail page, a knowledge-base document, the execute
screen, the run schedule screen, a public share link, both Zyra screens, the agent task list and a
task's detail, project API tokens, all four integration screens, both AI-provider screens, the OTP
screen, both invitation screens, and onboarding.

The two still reported uncovered — `/projects/:id/settings/integrations/linear` and
`/settings/integrations/linear` — **are** visited, by SWP-12 and SWP-13, which loop
`for (const provider of ["jira", "linear"])`. The counter cannot see a URL built from a loop variable
(§1). Left as-is rather than unrolled: the loop is the better test, and a coverage script should not
dictate how a spec is written.

**Deliberately out of scope** (declare it, don't let it happen by accident): live OAuth legs
(`integrations/:provider/auth-url`, real `callback`), superadmin `/api/admin/*` beyond authorization,
Stripe write paths (already env-gated), the static `privacy-policy` / `terms-and-conditions` pages,
`integrations/callback`, and `/setup` once a first admin exists. The four static ones are excluded
from the UI denominator by `OUT_OF_SCOPE_PAGES` in the coverage script rather than counted as gaps.

## 2. Wave status

| # | Wave | Status | Files | Tests | Red |
|---|---|---|---|---|---|
| 0 | Harness (coverage script, fixture factories, fake AI server) | **3 of 4 items done** — coverage script landed 2026-08-14 | 14 utils + 1 script | — | — |
| 1 | RBAC, members, invitations, project access | **specs complete** — awaiting product fixes 1–3 | 5 | 96 | 3 open |
| 2 | Attachments & storage | **API done and green** — UI half still pending | 1 | 25 | 0 |
| 3 | Custom fields | **done** — API + UI | 3 | 81 | 1 open (bug 11) |
| 4 | Import / export | **done** — 4 spec-side reds, see §5 | 2 | 37 | 4 spec defects |
| 5 | Knowledge Base v2 | **done 2026-08-17** — API + UI, 10 product fixes | 4 | 127 | 0 |
| 6 | Reports, analytics, dashboards | **API done** — `reports-ui` claimed, spec not written | 1 | 55 | 0 |
| 7 | Execution bulk ops, schedules, share links | **done 2026-08-14** — bulk ops implemented; **scheduled runs are not implemented** | 1 | 17 | 3 (missing feature) |
| 8 | Integrations (Jira, Linear) | **done 2026-08-14** — 15 product fixes; was wrongly marked "blocked" | 1 | 25 | 0 |
| 9 | Zyra, AI, RAG, MCP | **done 2026-08-17** — API + UI, 13 product fixes | 2 | 52 | 0 |
| 10 | The tail (notifications, activity, API keys, admin, ingest) | **done 2026-08-14** — 10 product fixes | 1 | 20 | 0 |
| 11 | Cross-cutting depth (boundaries, pagination, cascades, concurrency) | **partial** — pagination closed across all 7 sites; the rest not started | — | — | — |
| — | **Screens** (nav, projects list, project dashboard, theme) | **done** | 5 | 187 | 1 |
| — | **Screens sweep** (the 21 pages nothing opened) | **done 2026-08-14** | 1 | 17 | 0 |
| — | Regressions found while building the above | **done** | 2 | 8 | 1 spec defect |

**Wave 8 was not actually blocked.** The previous revision recorded it as blocked because
`api.atlassian.com` and `api.linear.app` are hardcoded, so no fake upstream can be pointed at them.
That is true and still true — but it only blocks the *outbound response handling*. Everything before
the outbound call is ours: authorization, the not-connected path, input validation, and the mirrored
ticket store (which can be seeded directly in Postgres). That turned out to be where all 15 defects
were. **A dependency on a third party blocks less than it looks like it does; check what happens
before the call before writing an area off.**

### The Knowledge Base and Zyra UI halves (2026-08-17)

`ui/knowledge-base.spec.ts` (20) and `ui/zyra.spec.ts` (21), on the `kb-ui` and `zyra-ui` tenants.
These were the two largest screens with API coverage and no browser coverage at all — 138 API tests
between them, and nothing driving the pages a user actually touches.

**Two product fixes, both found by the tests:**

1. **The KB delete confirmation was decoupled from reality in both directions.** The folder tree
   claimed "This folder contains documents/files" unconditionally, so emptying a folder and deleting
   it still warned about contents that were not there; the item table's row menu said only "it will
   be moved to trash", so deleting a *full* folder never mentioned that everything inside went with
   it. Both paths now call one `confirmFolderDelete()` that asks the API what is in the folder, and
   falls back to the cautious wording if the lookup fails. Verified in both directions by reverting
   the fix and watching KBU-10 and KBU-10b fail.
2. **Zyra's "test cases per task" conveyed its selection with colour alone** — no `aria-pressed`,
   no text — so nothing non-visual could tell which of the four was chosen. One attribute; the same
   defect class the theme pass fixed for contrast.

Findings worth keeping:

- **The KB page has no role gate.** Unlike the custom fields settings screen (`canManage` from
  project membership), it renders every control for everybody and lets the API refuse. That is
  correct here — any project member may write to the knowledge base — but it means the refusal path
  belongs to the account with *no project access*, not to a `qa_engineer`.
- **There is no trash UI.** Delete soft-deletes, the restore endpoints exist and are owner-or-manager
  gated, and nothing in the app can reach them. KBU-24 pins the gap: the row is gone from the
  screen, no restore affordance exists anywhere, and `PATCH .../restore` still works.
- **Creating a document navigates into it** rather than returning to the table — worth knowing
  before asserting on a row that will never appear.
- **Zyra's settings live on `projects.settings.zyraAgent`, not in a table of their own.** A
  capability switched off by one test stays off for the next test *and the next run*. The teardown
  drops the key (`settings - 'zyraAgent'`) to restore defaults; without that the three settings
  tests fail on state left by their own previous run, which reads exactly like a product bug.
- **`agent_name` must be `"Zyra the Test Generator"`** when seeding `ai_generation_requests`. The
  board filters on it, so a row with any other value is invisible on the board while still reachable
  by id — which looks like a UI bug and is not.
- **A completed Zyra task is just a row**, and `drafts` is `generated_payload` verbatim. That is what
  makes the whole review flow — select, save into a suite, delete, close — testable with no AI
  provider at all. The generation call itself still needs `utils/fake-ai-server.ts`.
- The Agents landing card **opens a modal**, it does not navigate; the modal carries the links to
  the chat and the board.

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

### Findings worth keeping — 2026-08-14

**Knowledge Base (Wave 5).** Three behaviours that are easy to get wrong twice:

- **Delete cascades; restore does not.** Deleting a folder soft-deletes every document and file beneath
  it, but restoring the folder brings back only the folder — it comes out of the trash **empty**, and
  each item must be restored individually. Pinned by `KB-A-46b` because nothing in the UI hints at it.
- **Three permission tiers, not two.** Reads are open to any project member; mutations follow
  `kbRequireMutateAccess` (owner, manager, *or the item's creator*, so a qa_engineer may edit what they
  made and nothing else); and restore-from-trash plus AI-memory approve/reject follow
  `kbRequireOwnerOrManager`. A qa_engineer can therefore delete their own document and then be unable
  to restore it.
- **`kbProjectRole` reads `project_members`, not the workspace role.** Promoting someone inside the
  project widens what they may edit even while their workspace role stays `qa_engineer` (`KB-A-47`).
- **`audit_logs` is append-only**, enforced by an `audit_logs_prevent_mutation` trigger, and
  `audit_logs.project_id` is `ON DELETE SET NULL` — so a project that has logged any activity **cannot
  be hard-deleted at all**, because the cascade attempts exactly the update the trigger forbids. A test
  that creates a throwaway project cannot fully clean up after itself; `KB-A-00` documents why it leaves
  the row behind rather than defeating an audit control from a fixture.

**This deployment runs `STORAGE_DRIVER=s3`.** The previous revision listed "only the local-disk storage
driver is exercised" as a Wave 2 gap — but `.env` sets `s3`, so the S3 branch is what the suite has
been running all along and the *local* branch is the untested one. Two consequences worth knowing:
`StorageService.exists()` returns `true` unconditionally on S3 ("checked lazily via the signed URL
request itself"), so the API's "File content is not available" branch is unreachable there and a caller
gets the bucket's XML `NoSuchKey` instead; and a binary download is a 302 to a presigned URL rather
than bytes.

**Assert zip contents by inflating them, not by substring.** Entry *names* sit in a zip's central
directory as plain text, so `zip.toString("latin1").includes("file.txt")` appears to work — but entry
*contents* are DEFLATE-compressed, so the same check on content can only ever pass by accident.
[utils/zip.ts](../e2e/utils/zip.ts) reads the central directory properly; the knowledge-base export
tests use it, and one of them now verifies a document's HTML actually round-tripped.

**`requireUser` throws 400, not 401, app-wide.** Every "anonymous caller" assertion in the suite pins
`[400, 401, 403, 404]` for that reason. It is a contract wart rather than a bug — changing it would
touch every route and every spec — but it is worth knowing before writing `toBe(401)` and concluding
the product is broken.

**In a UI spec, `page.request` uses the WEB origin.** `page.request.post("/api/...")` posts to the
frontend, which answers Next.js's 404 *document* — and the test then dies on "unexpected token <" while
parsing it as JSON, which looks nothing like the actual mistake. UI specs that seed fixtures must name
the API host (`env.apiBaseUrl`); `ui/screens-sweep.spec.ts` has an `api()` helper for it.

**A stub that answers 2xx is worse than a missing route.** This session found nine of them —
`bulkAssign`, `bulkStatus`, four schedule routes, `reviewScript`, and the notification pair — all
empty methods or fake payloads that reported success. Two got implemented, one got deleted, and the
rest now refuse or 501. The pattern to look for is a controller method with an empty body or a literal
return value: `grep -nE "^\s+[a-zA-Z]+\(\) \{\}?" legacy.controller.ts`.

## 3. Open product bugs the suite is red on

These tests assert the behaviour the product **should** have. They are red because it doesn't.

**Do not turn them green by weakening them** — no `test.skip`, no `test.fail()`, no loosened matcher,
no widened timeout. They clear when the product is fixed. (`api/authorization.spec.ts` predates this
rule and uses `test.fail()` for its known gaps; new specs don't.)

Verified red against a rebuilt image on 2026-08-14. **Four product bugs (5 red tests), one missing
feature (3 red tests), and one spec defect.**

| # | Bug | Where | Red test |
|---|---|---|---|
| 1 | `createSuite` / `createPlan` / `createCycle` take **no caller at all** — their controller methods never receive `@Req()`, so a workspace member with no project access can write into any project by id | `legacy.controller.ts` | `rbac.spec.ts` "a workspace member with no project access cannot write into the project" |
| 2 | …and so can a caller with **no session at all** | same | `rbac.spec.ts` "an anonymous caller cannot write into a project" |
| 3 | `analytics()` counts archived projects — `FROM projects` with no `archived_at` filter, unlike `testCaseCount` which uses the soft-delete-aware `testcases_active` view | `legacy.service.ts` | `workspace-setup.spec.ts` × 2 |
| 11 | `listTestCases` takes **no caller at all** — no `@Req()` on the route — so an anonymous caller can read any project's test cases, and each row carries a `customFieldValues` map | `legacy.controller.ts` | `custom-field-values.spec.ts` "…does not hand a project's custom field values to an anonymous caller" |

Bugs 1, 2 and 11 are the **last** three instances of the missing-`@Req()` pattern. Twenty-eight other
instances of it were fixed on 2026-08-14 (bugs 18–31 below), so the fix shape is now well established
and mechanical — two lines per handler, plus a `*ForProject` split where an internal caller has
already authorized:

```ts
const uid = this.requireUser(userId);
await this.requireProjectAccess(uid, projectId);
```

**These three are the first thing the next session should do.** They are the only remaining product
bugs in the suite, they share one fix, and `rbac.spec.ts` / `custom-field-values.spec.ts` already
specify the expected behaviour exactly.

### Missing feature, not a bug — scheduled runs

`EXO-A-07`, `EXO-A-08` and `EXO-A-10` in [api/execution-ops.spec.ts](../e2e/api/execution-ops.spec.ts)
are red because **scheduled runs do not exist**. There is no schedules table and no runner; the four
routes were stubs, of which `createSchedule` answered `201 { id: "local-schedule", ...body }` and
stored nothing — so the UI told the user their schedule was saved.

They now answer **501** with a message, and `EXO-A-08b` (green) pins that honest refusal so it cannot
regress to a fake success while the feature is missing. The three red tests are the specification for
the feature: they pass when it is built, and `EXO-A-08b` is the one to delete then.

Implementing a cron parser, a scheduler and a runner is a feature, not a bug fix, so it was left out
deliberately rather than half-done. **This is the one decision in this session that is the product
owner's rather than an engineer's:** build scheduled runs, or remove the routes and the UI that offers
them. Leaving them at 501 indefinitely is the worst of the three.

### Not a product bug — a spec defect

`api/workspaces.spec.ts` "same-named workspaces are distinct records, each owned by its creator"
asserts that `env.orgName` ("E2E Smoke Org") is owned by **exactly two** accounts, install-wide. It
counts owners across the whole database, so every re-run against the persistent volume adds one and
the assertion drifts. This breaks §4's idempotency rule — the fixture the assertion depends on is
shared and unbounded, not uniquely named.

The product is behaving correctly: the point the test makes (ownership is per-workspace) holds. The
fix belongs on the test side and is the narrow case §3's rule allows, because the *expectation itself*
is wrong — it should scope the query to the two accounts this spec created. Left in place for whoever
owns that file; do not "fix" it by relaxing the number.

### Fixed and verified green on 2026-08-14

Fourteen numbered defects, plus the pattern instances behind them. Every one was found by a test that
failed first, and every one is green now.

| # | Bug | Fix |
|---|---|---|
| 18 | **A new workspace's first project had no knowledge base.** `createOrgAndProject` never called `seedKnowledgeBaseDefaults`, which `createProject` does — the folder tree 404'd and creating a folder made an orphan second root | the same seeding call, inside the same transaction (`legacy.service.ts`). Regression test `KB-A-00` drives the real onboarding endpoint on a brand-new user |
| 19 | **A corrupt PNG uploaded to a knowledge base killed the API process.** tesseract.js rethrows inside its worker message handler when no `errorHandler` is supplied, outside the promise `recognize()` returns — an uncaught exception. Six container restarts in one test file | an `errorHandler` on `createWorker`, so the failure only rejects `recognize()` and the existing catch turns it into "no extractable text". Regression test `KBF-A-26` uploads a deliberately undecodable PNG twice and re-reads the row |
| 20 | **The whole Jira/Linear surface answered anyone.** 14 handlers took no `@Req()`: the mirrored ticket store was readable anonymously, the project mapping rewritable, and `jiraComment`/`linearComment` posted to the customer's real tracker with the workspace's OAuth token | caller + `requireProjectAccess` on all 14, with `jiraStatusForProject` split off for the two internal Zyra callers that hold no userId |
| 21 | **`NaN` reached SQL from any paginated endpoint.** `Math.max(1, Math.min(100, Number(query.limit)))` — NaN survives both, so `?limit=abc` put NaN in a LIMIT clause and Postgres answered with an error. Seven call sites | one exported `pageNumber()` guard, applied at all seven. A negative floors, a non-number falls back, `limit=0` stays a legitimate empty page |
| 22 | **Knowledge-base file payloads leaked `storage_key`**, contradicting the rule `getAccessUrl` states for itself — a caller holding the key can address the object without passing any access check | `kbFileView()` strips `storageKey` and `fileName` from all six response paths |
| 23 | **Previewing a plaintext file whose object had vanished was a 500.** On S3 `exists()` is a no-op ("checked lazily via the signed URL"), so the inline-plaintext branch — the only one that reads bytes — was where a missing object surfaced | the read is caught and becomes the same 404 the local-disk path gives |
| 24 | **`POST /ai/review-script` reported "passed" without reviewing anything** — no caller, no project, no model, `{ status: "passed" }` to every request including an unauthenticated one with an unparseable script | **route deleted**, the branch §3 bug 15 took. Nothing in the frontend called it. `ZYR-A-08b` pins that a reinstated version must authenticate and must not rubber-stamp |
| 25 | **The Zyra surface answered anyone.** 10 read and write handlers took no `@Req()` — chat transcripts (whatever the team told the agent about their product) and generated test cases were readable and mutable by any caller; `createZyraChatSession` opened sessions with a null `user_id` | caller + `requireProjectAccess` on all of them, plus `isUuid` guards on session and task ids |
| 26 | **`/api/cycles/*` answered anyone** — `getCycle`, `updateCycle`, `deleteCycle`, `executions`, `shareCycle` and the `cycle_items` routes took no `@Req()`. The product's own comment above `exportCycleExecutions` recorded this as an open gap. `DELETE` removed a run outright; `share` minted a public URL to one | a `requireCycleAccess()` resolver, and `executionsForUser` split from the unguarded `executions` for the export and share-token callers |
| 27 | **`updateExecution` resolved the execution but never its project** — a signed-in caller from any workspace could rewrite another team's result by execution id | `requireProjectAccess` on the resolved project |
| 28 | **The two bulk execution routes were empty methods** that answered 2xx and changed nothing, so the UI's "mark selected as Passed" and "assign selected" reported success and did nothing | implemented on top of `updateExecution`, so activity logging and the `Retest` rule stay identical to the single-execution path. Atomic (a batch naming an execution outside the run is refused whole), the status is validated against the six allowed values, and an assignee must be a project member |
| 29 | **The six `tesbo-reports/*` routes and both notification routes answered anyone**, ignoring the project in their own URL — and `tesbo-reports/settings` is shaped to carry an ingestion credential | caller + project check on all eight. The empty payloads remain: the ingest feature is unbuilt, which is now stated rather than implied |
| 30 | **`GET /api/branding` / admin branding** and the superadmin surface: verified refusing an ordinary owner, and public branding verified to leak nothing pre-auth | covered by `TAI-A-13/14/15`; no product change needed |
| 31 | **The v1 knowledge-base notes surface answered anyone** — `listKnowledge`, `getKnowledge`, `updateKnowledge`, `deleteKnowledge` and the per-item file route took no `@Req()`, so an item id was enough to read, rewrite or delete any project's note | caller + `requireProjectAccess`, and a `knowledgeItem()` resolver that scopes by project so an id alone is not authority |

**Signup findings worth keeping.** `verifySelfServeSignup` marks `pending_signups.consumed_at` rather
than deleting the row — the record of the signup survives as an audit trail, and `findPendingSignup`
filters on `consumed_at IS NULL AND expires_at > now()`, so "was it consumed?" is a question about that
column and not about the row's existence. Asserting `COUNT(*) = 0` there looks right and is wrong.
`signup/start` also answers **204 with an empty body** on purpose: saying whether the address was new
would make it an account-existence oracle for anyone who asks. `signup/verify` answers 201, Nest's
default for POST, which `start` opts out of with `@HttpCode(204)`.

**Also fixed:** `utils/reports-fixture.ts` was missing `seedRun` from its imports — a type error that
only *fails* on a database where the fixture does not already exist, which is why the reports suite
stayed green on the persistent volume while being broken for a fresh one.

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
- **A spec's own fixture is as likely to be wrong as the product.** Four of this session's first-run
  failures were the fixture, not the code: an `agent_name` that has to be one of `ZYRA_AGENT_NAMES`, a
  `generated_payload` that is a bare array rather than an object wrapping one, an `api_tokens` column
  called `token_hash` rather than `token`, and a UI spec seeding through the web origin. Read the
  failure before assuming a defect — and when it *is* the fixture, say so in a comment so the next
  person doesn't re-learn it.
- **Build authorization sweeps from thunks, not promises.** A list of already-started requests keeps
  firing after the first assertion fails, and its tail then rejects with "Request context disposed"
  once `afterAll` tears the contexts down — noise that buries the one real failure. Use
  `Array<[string, () => Promise<APIResponse>]>` and await each in turn.
- **The backend log is the mailbox — and the suite now enforces that it has to be.** Outside
  production the backend runs `EMAIL_DELIVERY_MODE=log`
  ([config/email-delivery.policy.ts](../Tesbo-Backend-Nest/src/config/email-delivery.policy.ts)):
  OTP codes are printed and posted nowhere, and invite/billing email is posted only after Postmark
  confirms the token belongs to a **sandbox** server, which delivers to nobody. So the OTP
  log-scraping path in `global-setup.ts` is the normal path again, not a fallback for
  "no token configured", and reading a code or an invite link means
  [utils/backend-logs.ts](../e2e/utils/backend-logs.ts) — don't re-implement `docker compose logs`.
  [api/email-delivery.spec.ts](../e2e/api/email-delivery.spec.ts) fails the run when the stack under
  test could reach a real mailbox; if it does fail, fix the stack's config, never the assertion. This
  is the guard against a repeat of the ~1100 bounces that got the Postmark account flagged.
- Uploads: build bodies in memory with `FormData` + `Buffer`
  ([utils/uploads.ts](../e2e/utils/uploads.ts)). `FilesInterceptor("files", 10)` needs a repeated
  field name, which Playwright's object form of `multipart` cannot express. No committed binaries.

---

## 5. The last run, and what is red in it

**Run the two projects separately.** A single `npx playwright test` covering all 874 has been killed
near the end (exit 144, no summary) more than once; per-project runs finish reliably and are the only
numbers worth quoting.

Latest run, **2026-08-14**, against images rebuilt from the current working tree (backend and
frontend both):

| Project | Result | Wall clock |
|---|---|---|
| `--project=api` | **9 failed, 612 passed, 3 skipped** | 2.0m |
| `--project=ui` | **5 failed, 256 passed** | 4.2m |
| **total** | **14 failed, 868 passed, 3 skipped** | 6.2m |

Unlike the 2026-08-12 run, **none of these is a stale-image artifact** — both images were rebuilt
immediately before the run, and every one of the 16 stale reds that revision listed is now green.

### All 14 accounted for

| Red | Count | What it is |
|---|---|---|
| `rbac.spec.ts` × 2, `workspace-setup.spec.ts` × 2, `custom-field-values.spec.ts` × 1 | 5 | §3 bugs 1, 2, 3, 11 — the last three missing-`@Req()` instances. **Product fix pending.** |
| `execution-ops.spec.ts` `EXO-A-07/08/10` | 3 | §3 "Missing feature" — scheduled runs are not implemented. **Product decision pending.** |
| `workspaces.spec.ts` × 1 | 1 | §3 spec defect — an install-wide owner count that drifts on every re-run. |
| `testcase-import.spec.ts` × 3 | 3 | **Spec defect, not a product bug.** `getByText("1 test case imported successfully")` resolves to two elements (the toast and the summary line), so it fails Playwright strict mode. Belongs to Wave 4's file — needs a `.first()` or a scoped locator. Not touched here per §7.2. |
| `projects-list.spec.ts` `PRJ-C-10` | 1 | **A test and a fix that disagree.** It asserts a duplicate project key is "reported inline and creates nothing"; bug 10's fix (`nextFreeProjectKey`) makes a colliding key auto-suffix and succeed instead. The fix predates this session and only became observable when the backend was rebuilt. Someone has to decide which behaviour is intended — auto-suffix or inline error — and then either the fix or the test is wrong. |
| `ui/custom-fields.spec.ts` "…shows its custom fields on their own tab" | 1 | **Contention flake.** 13/13 pass with `--workers=1`; it only falls over in a full parallel run. Added to the flake table below. |

So: **4 product bugs, 1 missing feature, 4 spec-side items, 1 genuine product-vs-test disagreement,
and 1 flake.** No unexplained reds.

The `testcase-import.spec.ts` count moves between 3 and 4 across runs for the same reason — those
locators are strict-mode-fragile *and* timing-sensitive. Treat any number in that file as "the locators
need fixing", not as a signal about the product.

### The backend unit suite has 23 pre-existing failures

```bash
cd Tesbo-Backend-Nest && npx jest
# 2 failed, 11 passed, 13 total; 23 failed, 250 passed, 273 total
```

`src/legacy/multi-workspace.spec.ts` (9) and `src/legacy/knowledge-document-comments.spec.ts` (14)
fail because their fixtures use ids like `"proj-1"` and `"user-2"`, and the `isUuid()` guards added by
an earlier wave's fixes now reject those before the test's own logic runs. **Confirmed pre-existing:**
both guards are present at `HEAD` (`git show HEAD:… | grep isUuid`), which this session did not touch.

The fix is mechanical — uuid fixture ids, plus a route in the db mock for the workspace and
project-access queries, exactly as was done for `linear-integration.spec.ts` when Wave 8's change
altered `connectLinearTeams`'s signature. Left for whoever owns those files. **Worth doing: a red unit
suite that everyone has learned to ignore stops being a safety net.**

### Contention flakes — re-run with `--workers=1` before believing them

These pass on their own and only fall over in a full parallel run. They are timing, not behaviour:

| Test | Alone | Budget |
|---|---|---|
| `ui/theme.spec.ts` `THM-12 workspace activity` (light and dark) | ~25s | 30s |
| `ui/theme.spec.ts` `THM-13` | ~66s | 90s (`test.slow()`) |
| `ui/navigation.spec.ts` `NAV-B-06/09` | 1.9s | 30s |
| `ui/testcases-pagination.spec.ts` | 1.9s | 30s |
| `ui/custom-fields.spec.ts` "…shows its custom fields on their own tab" | 19s for all 13 | 30s |

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

# the coverage counters — never the old shell one-liners, which were wrong three ways (§0)
node --experimental-strip-types --no-warnings scripts/coverage-report.ts
node --experimental-strip-types --no-warnings scripts/coverage-report.ts --uncovered
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

## 6b. Wave 12 — the reported-bug wave (2026-08-18)

Not a coverage wave. The 14 cards in the Basecamp board's **Writing Tests** column, each with a
BetterBugs session behind it, turned into specs. Source of the requirement is the BetterBugs
description in every case — the Basecamp card title is often looser than the report (card 3 says
"Internal Server Error while creating account"; the session says **workspace**, on `/onboarding`).

**52 tests across 8 files.** Suite total 972 → **1024 tests in 54 files**. Landed on `BugFixes` after
merging `E2ETest` into it.

> **Not yet executed.** These specs typecheck and enumerate (`--list`), and the counts above are
> measured from `--list`. **No test in this wave has been run**, at explicit request. Every "RED" and
> "green" in the table below is therefore a **prediction from reading the product code**, not a
> measurement — §5's rule applies: re-measure, don't re-quote. The first job for whoever runs them is
> to replace this table's states with observed ones, and to move the confirmed product bugs into §3.

| Ticket (BetterBugs) | Tests | File | State |
|---|---|---|---|
| Projects search not working (6a7c203d) | `PRJ-S-01..07` | `ui/projects-list.spec.ts` | green — implemented since the report |
| Projects sort/filter not working (6a7c1f28) | `PRJ-S-08..11` | same | green — sort implemented; there is no separate filter control, the search box *is* the filter |
| 500 creating a workspace (6a7afa2d) | `ONB-A-01..08` | `api/onboarding.spec.ts` (new) | **ONB-A-04 predicted RED** |
| Sign Up validation missing (6a7c621b) | `SGN-A-12..17` | `api/signup.spec.ts` | green — enforced both sides |
| Account label should be "My Account" (6a840253) | `ACU-01` | `ui/account.spec.ts` (new) | **RED** — still `<h1>Account</h1>` + sidebar "Account" |
| Password change needs a success message (6a8400e2) | `ACU-02..04` | same | green — `showToast` already there |
| Forgot/Reset password missing (6a7b24ef) | `ACU-05..10` | same | green — built end to end since the report |
| Onboarded without accepting invite (6a7d8189) | `INV-P-01..05` | `api/invitations.spec.ts` | green — pending invites confer nothing |
| KB blank documents need validation (6a7da01c) | `KBU-25..26` | `ui/knowledge-base.spec.ts` | **RED** — editor autosaves an emptied title |
| Search only works on Enter (6a7dae14) | `KBU-27` | same | **RED** for the KB screen; the repository screen debounces correctly |
| Repository count stale after delete (6a7c17a8) | `TCR-01..04` | `ui/testcases-repository.spec.ts` (new) | to be measured |
| Search clear button (6a7c1f86) | `TCR-05` | same | **RED** — no clear control on this screen (the KB screen has one) |
| Unselect all Columns (6a7c217f) | `TCR-06..07` | same | **RED** — `toggleColumnVisible` has no locked-column concept |
| Loading error after accepting invite (6a82d9a3) | 2 tests in "login reached from an already-accepted invite" | `ui/login-redirect.spec.ts` | green — root cause already fixed and covered; these add the entry path |

### New tenant kinds

`account-ui`, `repo-ui`, `invite-signin` — added to `RbacTenantKind`. Each exists for a reason worth
keeping:

- **`account-ui`** — every test in that file changes a real password. Sharing an account would leave
  the next spec (and `global-setup` on the following run) authenticating with a password that no
  longer exists. The file restores `FIXTURE_PASSWORD` in `afterEach`, through the product's own
  change endpoint rather than a hand-written hash.
- **`repo-ui`** — the repository header counters are absolute project-wide numbers. Any concurrent
  spec creating or deleting a case in the same project moves them mid-assertion.
- **`invite-signin`** — needs a redeemable invitation, and `api/invitations.spec.ts` clears its
  tenant's pending invites in `beforeEach`, so borrowing `invites` would delete the token mid-test.

### Findings worth keeping

- **`KBU-13` was a false positive.** It filled the knowledge-base search box and asserted the
  matching document was visible — but that screen's search is a `<form>` and `searchQuery` is only set
  in `onSubmit`, so `fill()` never searched. The document it asserted on was visible in the
  *unfiltered* list, so the test passed while testing nothing. Now presses Enter and asserts a decoy
  document drops out. This is the narrow spec-side fix §3 allows: the method was wrong, not the
  expectation.
- **`signup/start`'s rate-limit budget is nearly spent.** `OTP_MAX_ATTEMPTS` is 5 and the file now
  makes 3 attempts. A rate-limited `start` still answers **204** while writing no `pending_signups`
  row, so overspending does not fail loudly — it makes assertions flaky by file order. Any new test
  there expecting a 204 has to justify the attempt.
- **The invite-email half of 6a7d8189 is not a defect.** The invite *is* sent and
  `api/email-delivery.spec.ts` already pins that its accept link is emitted and works. Outside
  production `EMAIL_DELIVERY_MODE=log` means nothing reaches an inbox on purpose, which is what the
  reporter saw on stage. Only the authorization half was worth new tests.
- **`removeCycleTestCases` had no caller check** — found while merging `E2ETest` into `BugFixes`, not
  by a test. `BugFixes` added the bulk-delete on a base where `/api/cycles/*` was unguarded; `E2ETest`
  guarded every sibling route. The merge put an unauthenticated destructive route next to nine guarded
  ones. Fixed in the merge commit with the standard two lines plus `isUuid` filtering, matching
  `addCycleTestCases`.
- **Two counters disagreeing is the shape of 6a7c17a8.** The repository renders its numbers from
  `repoStats` (one fetch) and the suite tree from another, so `TCR-04` asserts the tree specifically
  rather than trusting that the stat cards standing in for it.

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

The 90% target is met, so this is no longer a coverage list — it is a correctness list.

1. **Fix §3 bugs 1–2 and 11** (one change: the last three missing-`@Req()` handlers), then bug 3's
   `archived_at` filter. That takes the suite to 4 red, all of them non-product.
2. **Decide on scheduled runs** (§3 "Missing feature") — build it, or delete the routes and the UI
   that offers them. They answer 501 today, which is honest but not a resting state.
3. **Resolve `PRJ-C-10`** (§5): does a colliding project key auto-suffix or refuse? The fix and the
   test disagree and one of them is wrong.
4. **Fix the four `testcase-import.spec.ts` strict-mode locators** and the `workspaces.spec.ts`
   idempotency defect — both spec-side, both small.
5. **Repair the 23 pre-existing backend unit failures** (§5).
6. **Commit.** Everything from 2026-08-12 and 2026-08-14 is still uncommitted.
7. Then depth, not breadth: **Wave 11** is the only wave left. Route-hit coverage is 100% and depth is
   unmeasured — the next real gain is the 4/4 axis in §1 (happy path + validation + 401 +
   cross-tenant per route), plus the two named gaps still open in Waves 2 and 6:
   - Wave 2: the attachments **UI** half, the storage warning ladder (80/95/100%), and `GET /api/bugs/:id`'s
     `attachments` array
   - Wave 6: `ui/reports.spec.ts` (the `reports-ui` tenant kind is claimed but the file does not exist)
   - Wave 0 item 3: `utils/fake-ai-server.ts`, which is what would let Wave 9 test an actual model
     round-trip rather than only the no-provider path
8. **Add `npm run coverage:gate` to CI.** It is already set at 100%, so a new controller route or a new
   screen fails until something asserts against it. That is what keeps 100% from being a one-day
   high-water mark — and the reason six measurement bugs went unnoticed for a day is that nothing was
   checking the checker.
