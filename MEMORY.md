# MEMORY.md — Tesbo Test Manager (full-codebase reference)

This file is a from-code reference map of the entire repository, built by reading the actual
source (not just filenames). It exists so a future session/engineer doesn't have to re-derive
architecture, conventions, and known footguns from scratch. It complements, not replaces,
[CLAUDE.md](CLAUDE.md) (mandatory workflow rules — DB safety, e2e-coverage mandate) and
[docs/FEATURE_DOCUMENTATION.md](docs/FEATURE_DOCUMENTATION.md) (product feature inventory +
known-gaps appendix).

If anything below conflicts with the current code, **trust the code** — this snapshot reflects
the repo as of 2026-08-24.

---

## 1. What this is

Tesbo Test Manager: AI-augmented QA test-case management SaaS, built by QAble Testlab. Self-hostable
(Apache-2.0, in the process of an open-source release — see §9.5/§9.8). Core domain: organizations
(="workspaces") → projects → suites → test cases → plans → cycles/runs → executions, plus bugs,
Jira/Linear integration, a knowledge base (RAG-backed), an AI agent ("Zyra") that generates test
cases, and an MCP server exposing project data to external AI coding tools.

**Monorepo layout** (repo root = `Tesbo-Test-Manager-Private/`):
- [Tesbo-Backend-Nest/](Tesbo-Backend-Nest/) — NestJS + TypeScript API, raw `pg` (no ORM).
- [Tesbo-Frontend/](Tesbo-Frontend/) — Next.js 16 (App Router) + TypeScript + Tailwind v4.
- [e2e/](e2e/) — Playwright suite (1,099+ tests), the *only* enforced test gate per CLAUDE.md.
- [load/](load/) — k6 load-testing suite, targets **production** by default.
- [infra/kubernetes/](infra/kubernetes/) — README only; real k8s manifests live in a separate,
  extracted repo ("Tesbo-Runner"/"Tesbo-Execution").
- [deploy/](deploy/) — simple single-droplet Nginx+Docker Compose deploy path (distinct from the
  real Jenkins blue/green pipeline that deploys `app.tesbo.io`).
- [docs/](docs/) — feature inventory, e2e coverage tracker, quality audit, Zyra behavior contract,
  OSS checklist, deploy guide.
- [scripts/](scripts/) — dev/deploy/e2e/load helper scripts (several are **macOS-only**).
- Root-level: `docker-compose.yml`, `docker.env.example`, `Jenkinsfile[.stage]`,
  `sonar-project.properties`, `.github/`, `.mcp.json`, `.codex/config.toml`.

**Root `package.json` is not a workspace orchestrator** — it only pins license metadata and a
stray top-level `playwright` dep. Backend, frontend, and e2e each manage their own
dependencies/scripts independently.

---

## 2. Ports & environment conventions (easy to get wrong)

Three different port pairs exist for the same app — mixing them up silently points tooling at the
wrong (or no) stack:

| Context | Frontend | Backend | Redis | Source |
|---|---|---|---|---|
| **This private repo's local dev / prod "blue" slot** | `1020` | `1021` | `6389` | [CLAUDE.md](CLAUDE.md), `Jenkinsfile` |
| Public/open-source repo defaults, `docker.env.example`, `scripts/docker-up.*` | `1010` | `1011` | `6379` | [README.md](README.md), `docker.env.example` |
| Staging blue/green (Jenkinsfile.stage) | blue `1010`/green `1020` | blue `1011`/green `1021` | `6379`/`6380` | `Jenkinsfile.stage` |
| Prod blue/green (Jenkinsfile) | blue `1020`/green `1030` | blue `1021`/green `1031` | `6389`/`6390` | `Jenkinsfile` |
| **`e2e/.env.example` defaults** | `1010` (`WEB_BASE_URL`) | `1011` (`API_BASE_URL`) | — | ⚠️ still the **public** pair, not this repo's `1020`/`1021` convention |
| Local npm dev (no Docker) | `3000` | `7000` | — | root `README.md` §"Local development" |

**Practical implication**: running the e2e suite against this private repo's stack without
overriding `API_BASE_URL`/`WEB_BASE_URL` will silently target the wrong or nonexistent service.

**Database — MANDATORY rule** (full detail in [CLAUDE.md](CLAUDE.md)): always use the
`DATABASE_URL` from the repo-root `.env` (a hosted Neon DB). Never point anything — backend,
migrator, e2e fixtures, one-off debugging queries — at a local Postgres. A stray
`tesbo-test-manager-private-postgres-1` container still runs on `:5442` with its own populated
schema; it *connects and returns plausible data* while being completely disconnected from the real
app, which is what makes this dangerous rather than obviously wrong. `docker-compose.yml` defines
no Postgres service at all, so this container's existence is invisible from reading the compose
file. e2e's `utils/psql.ts` throws hard if `DATABASE_URL`/`E2E_DATABASE_URL` is unset — there is
deliberately no local-socket fallback; don't reintroduce one.

---

## 3. Backend — `Tesbo-Backend-Nest/`

NestJS 10 + TypeScript 5.7, Node 22 (Dockerfile: `node:22-bookworm-slim`). **No ORM** — raw `pg`
`Pool` wrapped by `DatabaseService`; all SQL is hand-written and parameterized. No `class-validator`
DTOs, no global `ValidationPipe`, no interceptors/pipes at all — validation is manual per-field
`if`/`throw` checks in service methods.

### 3.1 Structure — one monolith + several newer modules

`src/` has no `projects/`/`testcases/`/`executions/`/`bugs/`/`zyra/`/`knowledge-base/` modules.
Almost the entire product surface (projects, suites, test cases, plans, cycles, executions, bugs,
knowledge base, Zyra chat/tasks, Jira/Linear read UI, notifications, activity, admin/branding,
onboarding, self-serve signup) lives in **`src/legacy/legacy.service.ts`** — a single 11,505-line
class (`LegacyService`) plus `legacy.controller.ts` (~215 of the app's ~240 total routes).

**"legacy" here means "predates the module-boundary discipline," not "deprecated."** It is the
majority of the live API and functions as the shared kernel: newer modules (`custom-fields`,
`billing`, `mcp`) depend back on it via `forwardRef()` for `requireProjectAccess`, `normalizeRole`,
and `logProjectActivity`. Any future "delete legacy" refactor must first extract those primitives
into a shared module.

Properly modularized (newer) slices: `admin/`, `audit/`, `auth/`, `billing/`, `common/`, `config/`,
`custom-fields/`, `database/`, `health/`, `integration-sync/`, `mcp/`, `plan-limits/`, `rag/`,
`setup/`, `storage/`.

### 3.2 Auth & multi-tenancy

- **Dual authentication**, converging on the same `sessions` table: email OTP (no password;
  `otp.service.ts`) and password login (`password.service.ts`, PBKDF2-SHA256, 210,000 iterations).
  Sessions are opaque random tokens, SHA-256-hashed server-side (not JWTs), cookie name hardcoded
  `tesbo_session`, lifetime `SESSION_DAYS` (default 30). Machine clients (MCP, scripts) use
  `Authorization: Bearer tsbo_<hex>` API tokens instead (`ApiTokenService`), stored only as a
  SHA-256 hash.
- **`AuthMiddleware` is global but "fail-open"**: it resolves `req.userId`/`req.apiToken` if
  present but does **not** reject unauthenticated requests itself. Every handler/service is
  individually responsible for calling `requireUser`/`requireSession`/`requireProjectAccess`. A new
  endpoint that forgets this is silently open. There is no global auth guard and no `@Roles()`
  guard/decorator — RBAC is inline `if (normalizeRole(...) === "qa_engineer") throw
  ForbiddenException(...)` duplicated at each call site.
- **Tenancy**: `organizations` (workspace) → `projects` → suites/testcases/plans/cycles/bugs/KB.
  A user has one **active workspace** at a time and switches via `POST /api/workspaces/:id/switch`.
  `requireProjectAccess(userId, projectId)` is the crux of isolation: it requires the project belong
  to the caller's **currently active** org, joined with `project_members` for role — so even a real
  member of a project in a different (or since-switched-away-from) org gets a 404. An invalid UUID
  is deliberately treated as 404, not 500, so probing never leaks existence.
- Two role-parsing functions, easy to confuse: `normalizeRole()` (DB values, unknown → safe default
  `qa_engineer`) vs `parseRole()` (request-body values, unknown → `null`, so a typo'd role can't
  silently under-grant).
- Roles: `owner` / `manager` (aliases `admin`, `test_manager`) / `qa_engineer` (aliases `qa`,
  `tester`, `member`) at both org and project level. Plus a separate **platform-admin** role
  (`platform_admins` table) for Tesbo's own staff, gating `/api/admin/*`.
- **MCP tokens** carry `projectId` + `scopes` (`read`/`write`); the MCP endpoint rejects browser
  sessions outright.

### 3.3 Billing (Stripe)

`billing/billing.service.ts` (1,053 lines). Plans: `launch` (free: 2 projects, 500MB, Jira-only, no
custom fields) vs `pro` (unlimited projects, 5GB, all integrations, custom fields). Billed **per
workspace**, not per seat.

- **Currency/country**: India-registered Stripe accounts can't charge Indian cards in non-INR
  (RBI rule). Precedence: `BILLING_FORCE_COUNTRY` override → trusted edge header (only if
  `TRUST_PROXY_COUNTRY_HEADER=true`) → IP geolocation (`ip-api.com`, cached 6h success / 60s
  failure) → workspace's self-declared country (soft signal only, logged if it disagrees but never
  overrides). Fails **closed**: unknown ⇒ not India ⇒ USD. Once Stripe locks a customer's currency,
  that wins over everything.
- **Webhooks** (`POST /api/billing/webhook`): signature-verified against `STRIPE_WEBHOOK_SECRET`
  (bad signature → 400, not 500, so Stripe stops retrying against a wrong secret); de-duped via
  `stripe_webhook_events` (`ON CONFLICT DO NOTHING`). `invoice.payment_failed` keeps Pro access —
  downgrade only happens once the subscription itself reaches `canceled`/`unpaid` (Stripe's own
  dunning runs first).
- **Reconciliation** (`POST /api/billing/reconcile`, also auto-run on post-checkout redirect):
  self-heals both under- and over-provisioned drift by querying Stripe directly — needed because
  the plan-flip webhook can be late/dropped/unconfigured. Admin-overridden workspaces
  (`plan_source='admin'`) are excluded on purpose.
- **Grace period / read-only lock** (`plan-limits/plan-limits.service.ts`): losing Pro drops billing
  to `launch` immediately but **Pro-sized limits persist** until `plan_grace_ends_at`
  (`PLAN_GRACE_DAYS`, default 30) — evaluated lazily on every check, no cron job, so nothing is ever
  deleted when the window closes; resubscribing instantly restores access with zero migration. Once
  grace ends, the **oldest N projects** (by `created_at`) stay writable; the rest go read-only —
  deterministic across calls.
- **`ProjectWriteLockGuard`** is the app's only global `APP_GUARD`, enforcing the lock across all
  ~67 mutating `/api/projects/:id...` routes at once (regex-matched path, not endpoint-registry
  based). GET/HEAD/OPTIONS pass through untouched; `DELETE` on the project root itself is exempted
  (archiving is the documented escape hatch). **Footgun**: any future route that moves project
  deletion to a different path must be added to this exemption manually.
- Frontend surfaces plan state via banners in `BillingTab` only — **no dedicated per-project
  "read-only" banner component exists anywhere else in the frontend** (see §4.6).

### 3.4 RAG / Knowledge Base / Zyra / MCP

- **RAG** (`src/rag/`) — from-scratch hybrid search, no vector-DB library, no LangChain. Storage:
  `knowledge_document_chunks` with **pgvector** (`vector` column, `<=>` cosine distance, HNSW
  index, hash-partitioned for locality). Ingestion is fire-and-forget via BullMQ with a
  deterministic job id (dedupes concurrent re-enqueues). Chunking splits markdown by heading level
  with breadcrumbs, then recursively on a separator cascade with overlap. Retrieval runs ANN + full
  text search **in parallel**, fused via **Reciprocal Rank Fusion** in application code; never
  throws — any failure resolves to `[]`. **Only OpenAI keys work for embeddings** (Anthropic has no
  embeddings endpoint); an Anthropic-only allocation resolves to "RAG unsupported," not an error.
  Boot-time self-heal sweep re-enqueues anything stuck `pending`/`queued`/`processing` from a crash
  — the same idiom repeats in Zyra chat plans and integration-sync runs.
- **Zyra** (the AI agent) lives inside `legacy.service.ts`, not its own module. Chat
  (`zyra_chat_sessions`/`messages`) and background "plan"/"task" generation
  (`zyra_agent_tasks`). Model calls are hand-rolled `fetch()`, no SDK — supports OpenAI-compatible
  chat-completions and the Anthropic Messages API directly (tries a candidate model-name list,
  falls through on model-not-found but fails fast on auth errors; **note**: Claude 4.6+ rejects a
  trailing assistant-role JSON prefill with 400, so the code asks for "raw JSON envelope only" in
  the system prompt instead — a dated compatibility detail worth re-checking against future Claude
  releases). Behavioral contract fully documented in
  [docs/zyra-agent-behaviour.md](docs/zyra-agent-behaviour.md): one AI call classifies intent, the
  backend then validates/gates/executes/reconciles; **the model never writes directly**; generated
  cases only ever appear in a structured table, never inline prose; **no draft buffer** — "create"
  writes immediately; every reply is reconciled against what actually happened so the model can
  never claim success for silently-failed work.
- **AI is 100% bring-your-own-key, per workspace, allocated per project** — there is **no**
  platform-wide `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` env var anywhere.
  `workspace_ai_keys` (encrypted at rest) → `project_ai_key_allocations`. Key-resolution logic is
  duplicated in **three separate places** on purpose (to avoid module cycles):
  `LegacyService.zyraAiAllocation`, `rag/rag-ai-allocation.ts`, and
  `integration-sync/integration-sync-decisions.ts` — these can drift.
- **MCP** (`src/mcp/`) — a real Model Context Protocol JSON-RPC 2.0 server at
  `POST /api/projects/:projectId/mcp`, bearer-token-only (browser sessions rejected). 7 tools
  (`list_projects`, `list_testcases`, `create_testcase`, `create_suite`,
  `create_cycle_from_plan`, `record_execution_result`, `create_bug`, `get_requirement_matrix`),
  each a thin wrapper over the same `LegacyService` methods the REST API uses. Writes are
  attributed to a dedicated `tesbo-mcp` actor (not a human user), via a shared actor-identity model
  where `actors.id` reuses the same UUID as `users.id`/`agents.id`. **Frontend has zero UI for
  generating MCP-scoped API tokens beyond a settings page that surfaces the URL/token** — the
  "connect an MCP client" journey is curl/Postman-only for now, per
  `docs/FEATURE_DOCUMENTATION.md`'s Finding B.
- A separate, **read-only-from-this-backend's-perspective** "Tesbo Reports" surface exists
  (`tesbo_report_runs`/`tesbo_report_cases`/`tesbo_alert_rules`/`tesbo_run_shares`,
  `GET /api/projects/:projectId/tesbo-reports/*`) with no `INSERT` anywhere in `src/` — combined
  with unreferenced `TESBO_ARTIFACT_STORAGE_PROVIDER`/`TESBO_SPACES_*` env vars, this strongly
  implies an **external Tesbo CLI/reporter tool writes directly to this Postgres DB and/or a
  separate S3-compatible store**, bypassing this API. Don't assume this backend is the only writer
  to its own database. (The frontend has a fully-typed API client for ~20 of these endpoints that
  **no page calls** — fully unreachable UI, per Finding B.)

### 3.5 Integration-sync (Jira/Linear)

`src/integration-sync/` mirrors ticket-tracker issues into the Knowledge Base (distinct from the
primary Jira/Linear read/link UI in `legacy.service.ts`). BullMQ-backed; concurrency safety comes
from a **partial unique index** on `integration_sync_runs` (a second "Sync" click fails the INSERT
at the DB level and the code returns the already-running run — race-safe without an app lock).
Per-ticket jobs retry 3× with backoff; the run-level coordinator job doesn't retry (a retry would
re-page the whole provider backlog). Progress uses a single atomic `UPDATE ... RETURNING` so two
workers finishing simultaneously can't both think "not done." Each provider gets its own KB folder,
created lazily on first sync. Self-heals interrupted runs on boot. Deliberately keeps its own HTTP
client and AI-decision-summary extractor rather than reusing `LegacyService`'s, so the module
dependency arrow only ever points one way (`IntegrationSyncModule → RagModule`, imported *by*
`LegacyModule`).

### 3.6 Database

No ORM. Key structural facts:
- **Soft delete**: `testcases`/`executions` have `deleted_at`; `testcases_active`/`executions_active`
  convenience views filter it — but **not every query necessarily uses the view**, so a
  hand-written `FROM testcases` without a `deleted_at IS NULL` clause is a real risk in new code.
  (Confirmed real bug: `analytics()` counts archived projects because it doesn't use the
  soft-delete-aware view — see [docs/e2e-coverage-waves.md](docs/e2e-coverage-waves.md).)
- **Versioning**: `testcase_versions` is populated by a **Postgres trigger**
  (`testcases_snapshot_before_update`), not application code — snapshots the pre-change row as
  JSONB before every UPDATE (including soft-deletes), skips no-op saves, can't be bypassed by any
  application code path including bulk ops.
- **Immutable audit log**: `V62_audit_logs_immutable.sql` makes `audit_logs` append-only (blocks
  UPDATE/DELETE); FKs from it use `ON DELETE SET NULL`, so anything ever audited can never be
  hard-deleted — fixtures/cleanup code must tolerate leftover rows.
- **pgvector**: `knowledge_document_chunks.embedding`, HNSW index, hash-partitioned.
- Full-text search: `testcases.search_vector` (trigger-maintained) plus a `pg_trgm` index for
  fuzzy/substring search; KB documents/files have their own search vectors.
- **Migrations**: 82 hand-written `V<n>_<name>.sql` files, run by a bespoke checksum-tolerant runner
  (`src/database/migrate.ts`) — takes a Postgres advisory lock, tolerates known drift (unknown
  applied versions, and "version forks" where the same version number holds different SQL on
  different environments — `V76` is named explicitly as an example), but a genuine content mismatch
  on a matching version+filename still hard-fails. `V78`/`V79` literally share a filename
  (`cycle_items_unique_testcase.sql`) — tolerated by the checksum/filename dedup logic.

### 3.7 Config & boot-time gotchas

- `main.ts` loads `.env` **twice** on purpose: several classes read `process.env` in `static
  readonly` field initializers that evaluate at import time, before `AppConfigService`'s own
  `dotenv.config()` runs during Nest's DI cycle. A new config value added as a `static readonly`
  field anywhere (instead of via `AppConfigService`) will silently miss `.env` overrides.
- App **hard-fails to boot** without `SECRETS_ENCRYPTION_KEY` (`assertEncryptionKeyConfigured()` at
  the very start of `bootstrap()`) — no degraded mode. A fresh checkout with the example blank key
  won't start until one is generated (`openssl rand -base64 32`).
- **`EmailDeliveryPolicy` is load-bearing, not cosmetic.** In `log` mode (default), OTP codes
  **never** reach Postmark under any circumstance — only stdout. Other emails (invites, billing,
  storage warnings) *do* get posted to Postmark in log mode, but only after probing Postmark's API
  to confirm the token belongs to a Sandbox server; a **Live** token in `log` mode sends nothing at
  all (one-time console warning). This exists because a live token was once used locally while e2e
  invented ~1,100 nonexistent addresses, flagging the sending account. Debugging "invites aren't
  arriving" → check `/api/admin/system/health`'s `email.reach` field, not just whether the token is
  set.
- `no-floating-promises` is ESLint-enforced; the intentional pattern for fire-and-forget work is
  `void promise.catch(() => undefined)`, not omitting the check.
- Compression is global; no streaming/SSE routes exist today — a `main.ts` comment warns that
  adding one (e.g. Zyra chat → SSE) needs `Cache-Control: no-transform` or the global
  `compression()` middleware will buffer and break the stream.
- Stray zero-byte junk file: `src/__t3` (no references anywhere) — harmless, worth deleting.

### 3.8 Testing

15 Jest spec files, colocated with source (`jest --runInBand`, serial — several tests likely hit a
real/shared DB). No coverage config. **This is unit/integration coverage only** — the mandatory
end-to-end product coverage lives entirely in the sibling `e2e/` Playwright suite (see §5), per
[CLAUDE.md](CLAUDE.md).

---

## 4. Frontend — `Tesbo-Frontend/`

Next.js 16 (App Router) + React 19 + TypeScript, Tailwind v4 (CSS-first config, no
`tailwind.config.js` — theme tokens are CSS custom properties in `app/globals.css`).

### 4.1 No framework scaffolding beyond Next itself

**No state-management library, no data-fetching library (no react-query/SWR/axios), no form
library.** A single hand-written `fetch` wrapper (`lib/api.ts`) is the entire backend client;
components manage loading/error state with plain `useState`/`useEffect`. There is **no shared
cache, no request de-duplication** — e.g. `Sidebar.tsx` and `TopBar.tsx` independently call
`getWorkspace()`/`listProjects()`/`authMe()` on every authenticated page load. Adding React
Query/SWR later would be a broad refactor, not incremental.

### 4.2 Auth gating is entirely client-side — `proxy.ts` is a deliberate no-op

There is no `middleware.ts` (Next 16 renamed the convention to `proxy.ts`). This app's
[proxy.ts](Tesbo-Frontend/proxy.ts) is intentionally a passthrough — **do not "fix" this as if it
were dead code.** Reason (documented in its own comment): the backend's `tesbo_session` cookie is
host-scoped to the API origin (`api-app-stage.tesbo.io`), not the frontend origin
(`app-stage.tesbo.io`), so a server-side cookie check would 307-redirect even while `authMe()`
(cross-origin, `credentials: "include"`) sees a valid session — producing an infinite bounce loop.
So every authenticated page independently does:
```ts
useEffect(() => {
  authMe().then((me) => { if (!me) { router.replace("/login"); return; } /* load data */ });
}, []);
```
Consequence: no page is server-protected — the initial HTML shell of any route is always visible
(though it renders no real data until the client-side check passes), and every navigation pays a
round trip to `/api/auth/me` before showing content.

**Redirect-loop protection** lives in `lib/redirect.ts`: sanitizes `?redirect=` (rejects
protocol-relative `//`, control chars, `/login` itself), tracks one in-flight attempt via
`sessionStorage` with a 10s TTL, and has a hard timeout fallback (2.5s/6s) so a stuck "Loading..."
state can't persist forever — documented as a fix for a real production incident where a
redirect-back-to-`/login` re-rendered the *same* component instance rather than remounting it.

### 4.3 `lib/api.ts` — single ~3,560-line API client file

No domain splitting (`lib/api/testcases.ts` etc. don't exist) — grep, don't browse, to find a
call. Session auth is entirely cookie-based (`credentials: "include"` on every call); no token in
localStorage (aside from one vestigial dead-code `removeStoredValue("token")` call in `Sidebar`'s
logout handler). Notable internal inconsistency: `listTestCases` bypasses the shared `api()`
helper and re-implements fetch/error-handling inline (needs to read the `X-Total-Count` header,
which the generic wrapper doesn't expose) — including re-reading `process.env.NEXT_PUBLIC_API_URL`
directly instead of the module's own `API_BASE` constant.

**Three distinct "runs" concepts live in this one file — do not conflate them**:
1. Test cycles/runs (`listTestRuns`/`getTestRun`, aliased `listCycles`/`getCycle`) — the manual
   execution feature.
2. Browser-automation session recording (`startAutomationSession`, `compileAutomationRecording` →
   produces a Playwright script) — a "record actions in a live browser, turn into a script" feature.
3. `Tesbo*` functions (`listTesboRuns`, `ingestTesboPlaywright`, `TesboAlertRule`) — the external
   CI/Playwright-ingestion reporting surface described in §3.4, currently unreachable from any page.

`lib/validation.ts` explicitly mirrors backend validation rules (name/password/email, KB upload
limits) — comments warn these **must be kept manually in sync**; there is no shared schema.

### 4.4 Routing

Root `app/page.tsx` redirects based on `getSetupStatus()` (fresh self-hosted install → `/setup`)
then `authMe()` (→ `/projects` or `/login`). `(app)/layout.tsx` renders the authenticated shell
(Sidebar/TopBar) but does **not itself gate auth** — each page under it independently checks.
`/settings` is gated to `owner`/`manager`/platform-admin roles. `/share/[token]` is the one fully
public, unauthenticated route (external test-run report). `/integrations/callback` is a shared
OAuth landing page for both Jira and Linear, parsing a signed `state` param client-side (signature
verified server-side) and using a `sessionStorage` key to know where to return the user.

### 4.5 Zyra UI

Chat mode (`/agents/zyra`) and task mode (`/agents/tasks`). **No streaming** — despite being an AI
chat UI, `sendZyraChatMessage` is a plain await-the-full-response POST, not SSE/WebSocket token
streaming (matches the backend's no-streaming-routes state in §3.7). The chat UI hand-rolls its own
markdown renderer (not a library). Agent overview page explicitly does **not** sum
`task.generatedCount` client-side to show "test cases created" — a comment references a real bug
(chat-mode-created cases weren't counted since chat writes no generation row); the backend now
authoritatively counts a `zyra_created` audit action instead. Two "future agent" cards ("Run
Analyst", "Bug Triage") are static placeholders — Zyra is the only real agent today.

### 4.6 Billing UI

`components/settings/BillingTab.tsx` + `components/PricingModal.tsx`. Surfaces
`paymentFailedAt`/`inGracePeriod`/`limitsEnforced`/`cancelAtPeriodEnd` as color-coded banners.
Checkout return reconciles directly against Stripe (`reconcileBilling()`) rather than trusting the
redirect, since the plan-flip webhook can be late/dropped. **Gap**: no dedicated per-project
"read-only, upgrade to unlock" banner component exists anywhere outside the Billing tab — the
actual lock enforcement is server-side (§3.3); a new engineer adding project-lock UI elsewhere
needs to build that from scratch, not find an existing component to reuse.

### 4.7 `visualguideline.txt` is aspirational, not descriptive

The 720-line design spec describes a **teal** brand, a "Command Center/Scenarios/Reviews/Defects"
nav with named agents `Aegis`/`Sentinel`, and an explicit "no chat bubbles" rule. **None of this
matches the actual implementation**: `app/globals.css` uses a **violet** brand scale
(`--brand-primary: #4A2FA0`) with only the AI-accent indigo matching the spec; the real
`Sidebar.tsx` nav is `Overview`/`Test management`/`Execution`/`Assets`; Zyra is the only agent and
its UI *is* chat bubbles. Treat this file as design intent/history, not current ground truth —
`app/globals.css` and the actual components are the source of truth for current tokens/nav/UI.

### 4.8 Testing

**Zero automated tests inside `Tesbo-Frontend` itself** — no `*.test.*`/`*.spec.*`, no test runner
in `package.json`. ESLint is the only quality gate. All product-level coverage for this frontend
comes from the sibling `e2e/` suite.

---

## 5. e2e — `e2e/` (the mandatory test gate)

Playwright, **1,099 tests across 58 files** (721 API / 378 UI) as of the last quality audit
(2026-08-19), targeting a deployed instance (not mocks). Full workflow (identify scenarios →
automate → run impacted specs only → treat failures as product bugs) is mandated in
[CLAUDE.md](CLAUDE.md) for *every* behavior-changing PR — see that file for the phase-by-phase
protocol, it's not duplicated here.

### 5.1 Tenant-isolation-first architecture

`fullyParallel: false` only serializes tests **within** one file — different files still run
concurrently across workers — so nearly every spec file owns its own **disposable tenant** rather
than sharing one workspace, to avoid cross-file state races. `global-setup.ts` provisions, in
order: Account A (shared by most specs), Account B (cross-tenant IDOR checks only), a per-file
Billing API tenant and Billing UI tenant (each rewrites plan/grace/dunning columns directly via
SQL — can't share), a Workspaces tenant (repoints the caller's active workspace, would corrupt
sharing specs), and a Screens tenant (force-upgraded to Pro via SQL, since Launch's 2-project
ceiling can't support "assert on the whole projects list" suites). Every account is provisioned via
try-password-login → try-OTP-signup (scraping the code from `docker compose logs backend`) →
direct-DB-seed fallback, retried 3× with backoff (tolerates a freshly-deployed stack being flaky).

**Global `storageState` = Account A's session** — any new `APIRequestContext`/browser context
silently inherits an authenticated session unless explicitly cleared with `NO_SESSION`. An
"anonymous" test that forgets to clear it gets a 200 where it expected 401 — a named, called-out
footgun.

### 5.2 Database rule enforcement (code-level)

`utils/psql.ts`/`utils/billing-db.ts` enforce the same rule as §2: SQL is passed as an **argv
element** (`execFileSync`), never piped via stdin through `docker compose exec -T` — piped stdin
can be silently dropped under concurrent Playwright workers, so psql exits 0 having run nothing
("fixture appears applied but wasn't"). `execAllowingAuditImmutability()` swallows exactly one
error class (`audit_logs is append-only`, from `V62`) — fixtures must tolerate leftover audited
rows rather than erroring on delete.

### 5.3 Never touches real Stripe / real mailboxes

Billing lifecycle testing (`api/billing-lifecycle.spec.ts`) drives state entirely via **locally
HMAC-signed synthetic webhooks** (`utils/stripe-webhook.ts`) — zero real Stripe calls, safe even
against a deployment with a live key. `api/email-delivery.spec.ts` fails the whole run if the stack
under test could actually reach real mailboxes, and `E2E_EMAIL_DOMAIN` defaults to the real,
mail-accepting `mailinator.com` (not a fake `.local` domain) as a second line of defense after a
past incident of ~1,100 bounces flagging the Postmark account.

### 5.4 `e2e/scripts/coverage-report.ts`

A from-scratch static coverage analyzer — its own comments document the coverage number itself
being **silently wrong three separate times** before being trusted (query-string stripping,
apostrophe-shifted quote pairing, parameter-vs-literal route mismatch each undercounted; one bug
turned a 107-test KB suite into "6 covered paths"). Lesson stated explicitly in the tool: "a
coverage number is a program, and it needs tests of its own."

### 5.5 Known state (read before assuming the suite is green)

Per [docs/e2e-coverage-waves.md](docs/e2e-coverage-waves.md) and
[docs/e2e-quality-report-2026-08-19.md](docs/e2e-quality-report-2026-08-19.md):
- 98–100% structural (route/page) coverage, but the **last saved full run was red with 119 failed
  test IDs**, not yet triaged — grade "B- test design / C operational reliability," explicitly "a
  high-confidence regression asset, not yet a standalone release certificate."
- **A real, still-open platform-wide IDOR gap**: `createSuite`/`createPlan`/`createCycle` accept
  callers with zero project access (and even fully anonymous callers) because those controller
  methods are missing `@Req()`, so no caller can be resolved and `requireProjectAccess` never runs;
  `listTestCases` has no caller at all either. 28 other instances of this exact pattern were already
  found and fixed in-session (documented individually in the tracker) — "the fix shape is now
  mechanical: two lines per handler." See `api/authorization.spec.ts` for the regression suite (all
  its tests assert the *secure* 403/404 and currently fail where the gap remains).
- No mandatory CI gate exists yet; many suites silently `test.skip` when Docker/Postgres/billing
  config is unavailable, and CI doesn't fail on unexpected skips.
- Password-recovery flow (`forgot`/`reset/:token`/`reset`) has **no direct API test coverage** —
  only indirect UI-journey coverage. Flagged as security-relevant.

### 5.6 Running it

Governed entirely by [CLAUDE.md](CLAUDE.md)'s Phase 3 (ask first, `--workers=10`, own visible
Terminal window via `scripts/e2e-run.sh`). **`scripts/e2e-run.sh` and `scripts/load-run.sh` are
macOS-only** (hard dependency on `osascript`/`Terminal.app`) and will not run as-is on this Windows
machine — this is a real environment mismatch to flag before attempting either script here.

---

## 6. load — `load/` (k6)

Targets **production** (`app.tesbo.io`) by default — this is not a local/staging-only tool.
Validates real, code-derived limits (500-row page-size ceiling, 500-row bulk-create ceiling, 30s
Postgres statement timeout, 20-connection pool, 10s pool-acquire timeout, Cloudflare's 100s proxy
limit, 20MB body limit). Scenarios: `seed.js` (5,000-case fixture), `s1-repository.js` (read-only),
`s2-run-build.js` (writes 50,000 cycle_items + executions), `s3-mixed-50vu.js` (mixed
read/write concurrency — finds pool exhaustion), `s4-breakpoint.js` (open-model breakpoint search,
deliberately not closed-VU so saturation isn't hidden as reduced throughput), `teardown.js`
(dry-run by default, deletes only rows tagged `RUN_TAG`). `lib/config.js` refuses to start without
an explicit `PROJECT_ID` (no default/discovery that could wander into a customer workspace). Uses a
project-scoped bearer API key, never a session login, so 50 VUs don't hammer the login endpoint.
**Never touches Stripe/billing.** Production safety rails: dedicated project only,
typed-confirmation prompt before any write scenario, `abortOnFail` at 5% (25% for breakpoint test),
ramps never step loads.

---

## 7. Infra & deployment

Three distinct, coexisting deployment concerns — don't conflate them:

1. **`infra/kubernetes/`** — README only. The real k8s manifests, and the queued/scheduled
   Playwright test-execution plane, were extracted to a separate **"Tesbo-Runner"/"Tesbo-Execution"**
   repository. `.gitignore` still has secret-file patterns (`base/registry-secret.yaml`, `*.pem`)
   for a `base/` overlay structure that no longer exists here — confirming manifests used to live
   in this repo before extraction.
2. **`deploy/`** — a simple single-droplet path: `deploy/Tesbo-Backend/` and
   `deploy/Tesbo-Frontend/` each hold a minimal `docker-compose.yml` binding to `127.0.0.1` only
   (Nginx fronts them), plus `deploy/nginx/setup-ssl.sh` (idempotent Nginx+Certbot setup,
   `client_max_body_size 1100M`, `proxy_buffering off` for SSE/WebSocket support, 86400s timeouts).
   Companion doc: [docs/deploy-guide.md](docs/deploy-guide.md).
3. **Jenkins blue/green** — the pipeline that actually deploys `app.tesbo.io`/`api-app.tesbo.io`
   (prod, `Jenkinsfile`, triggers on `main`) and `app-stage.tesbo.io` (staging, `Jenkinsfile.stage`,
   triggers on `dev`). Shape: checkout → SonarQube scan (non-blocking) → SSH deploy → smoke check.
   Builds+starts the **idle** color while the live one keeps serving, polls its `/health` up to
   180s, only then rewrites the host Nginx `proxy_pass` port via `sed` and reloads, re-verifies the
   public HTTPS endpoint, and only *then* stops the previous color (`docker compose down
   --remove-orphans` — never `-v`, so volumes/DB are untouched). Rolls Nginx back on any
   health-check failure rather than leaving a bad cutover live. Staging additionally routes through
   a WAF/reverse-proxy (SafeLine) whose own ports never change — only the *host* Nginx flips
   underneath it. **Documented near-miss class of bug**: an unquoted SSH heredoc under Jenkins'
   durable-task shell can execute the deploy body on the Jenkins agent instead of the production
   host — always use the quoted form (`<<'ENDSSH'`).

**`docker-compose.yml`** (the local/dev stack): `redis` (durable AOF, so queued RAG-embedding jobs
survive restarts), `migrator` (runs once, `backend` waits on its success), `backend`, `frontend`.
**No Postgres service** — by design (see §2's DB rule). ⚠️ **Security footgun**: a hardcoded
fallback `SECRETS_ENCRYPTION_KEY` is baked directly into `docker-compose.yml`
(`QtqFfNpvzyRZvBpFeXYIFmQMTwQHVXHQYbH85YvhlvE=`) — anyone spinning up this compose file without
overriding it in `.env` gets a **publicly-known encryption key** protecting OAuth tokens at rest.
Always set a real one for any shared/non-local environment. Note also that `NEXT_PUBLIC_*` vars are
baked into the frontend image at **build** time — changing `NEXT_PUBLIC_API_URL` after the image
exists requires a rebuild, not just a restart.

**`docker.env.example`** has **three separate, overlapping variable families for object storage**
(`S3_BUCKET` vs `S3_BUCKET_NAME`; a legacy `AWS_ACCESS_KEY_ID`/`SECRET`/`REGION` block; a further
`TESBO_ARTIFACT_STORAGE_PROVIDER`/`TESBO_SPACES_*` block) — genuinely confusing when configuring
storage from scratch; only the plain `S3_*`/`STORAGE_DRIVER` vars are actually read by
`AppConfigService`.

---

## 8. CI, dependabot, MCP config

- `.github/dependabot.yml` scans weekly across root, frontend, backend, and github-actions — but
  **every ecosystem has `open-pull-requests-limit: 0`**, so it will detect vulnerabilities/updates
  but **never open a PR**. Effectively disabled while looking configured; contradicts the OSS
  security posture implied elsewhere.
- `sonar-project.properties` scans only `Tesbo-Frontend` + `Tesbo-Backend-Nest/src` — `e2e/` and
  `load/` are explicitly excluded from static analysis.
- `.mcp.json` (Claude Code) and `.codex/config.toml` (Codex) both configure the **same** external
  MCP server: BetterBugs (`https://mcp.betterbugs.io/mcp`) — the bug-tracker referenced throughout
  e2e spec regression comments (e.g. "Reported as ... BetterBugs 6a7c763c").
- `.vscode/settings.json` sets a **Java-specific** build setting in this TypeScript monorepo — see
  §9.4 (legacy-naming debt) for why.

---

## 9. Documentation, contributing, and legacy-naming debt

### 9.1 [docs/FEATURE_DOCUMENTATION.md](docs/FEATURE_DOCUMENTATION.md) (3,639 lines)

From-code feature inventory across 9 product areas. Its Appendix ("Known Gaps & Risk Areas") is the
single most important reference for known bugs — highlights already folded into §3/§5 above
(the IDOR gap, non-functional stubs: bulk execution actions, recurring-run scheduling despite full
schema+UI, hardcoded-`[]` notifications, canned "AI Script Review," unreachable Tesbo-Reports
ingestion client, all-zero `cycles/:id/report/summary`, fully-implemented-but-UI-less Project API
Keys). Ten additional concrete reproducible bugs are documented with exact code locations,
including: `updateBug`'s `COALESCE(newValue, oldValue)` pattern meaning **fields can never be
cleared once set**; a suite rename that silently promotes a child suite to root (rename UI only
sends `{name}`, `parentId` isn't `COALESCE`d); public share links leaking far more raw data via the
JSON endpoint than the rendered page shows; removing a case from a run **hard-deleting** its
execution history (bypassing the soft-delete columns added for exactly this); duplicate-name AI-key
creation silently replacing the old key's secret with no warning; onboarding's invite-team step
having no role check (self-escalation risk).

### 9.2 [docs/e2e-coverage-waves.md](docs/e2e-coverage-waves.md) and [docs/e2e-quality-report-2026-08-19.md](docs/e2e-quality-report-2026-08-19.md)

Living e2e tracker and an independent 5-days-later audit — see §5.5. The tracker's own instruction:
"this file is the source of truth... if it disagrees with a conversation, believe this file." Hard
rule stated there: red tests are never turned green by weakening them (no skip/loosened
matcher/widened timeout) — only by fixing the product.

### 9.3 [docs/zyra-agent-behaviour.md](docs/zyra-agent-behaviour.md)

The Zyra behavioral contract — see §3.4. Its changelog documents real production incidents this
contract was hardened against (e.g. a regex classifier once read "Yes, please start generating" as
small talk and dropped the model's own operations while still claiming success).

### 9.4 Legacy Java-product naming debt (scattered, real)

Multiple independent signals point to this repo being the successor to an earlier **Java/Spring**
backend (possibly literally named "BetterCases"), rewritten in NestJS, with cleanup incomplete:
- [CONTRIBUTING.md](CONTRIBUTING.md) is **actively wrong** — describes a `Tesbo-Backend/` Java 17
  Maven service and instructs `mvn test`; neither the directory nor Maven exist in this repo (the
  real backend is `Tesbo-Backend-Nest/`, no `pom.xml`). A new contributor following it literally
  cannot find what it describes.
- `deploy/Tesbo-Backend/app.env.example` uses a `jdbc:postgresql://.../bettercases` connection
  string — a JDBC scheme and legacy DB name a Node backend has no direct use for.
- `.vscode/settings.json` carries a Java build-config setting.
- `.gitignore` still ignores `Tesbo-Backend/uploads/` (the old directory name).
- `scripts/create-postgres-user.sh` defaults to username/password `lifetools`/`lifetools` — a name
  with no connection to "Tesbo," suggesting copy-pasted boilerplate from an unrelated template.
- [RELEASE_NOTES.md](RELEASE_NOTES.md) itself acknowledges: *"Some technical identifiers, routes,
  database names, and environment variables still use existing `tesbo` naming for compatibility."*
- `.github/ISSUE_TEMPLATE/feature_request.yml` thanks contributors for "helping shape **TesboX**" —
  yet another product-name variant.

### 9.5 [docs/OPEN_SOURCE_CHECKLIST.md](docs/OPEN_SOURCE_CHECKLIST.md)

Pre-publish checklist, not fully checked off: scan git history for secrets, rotate anything found,
review `deploy/`/`infra/`/`.github/` for internal domains/account IDs, keep the first public release
scoped to the "simple test case management" story (deliberately omit AI/Zyra/billing complexity
from the initial OSS narrative). Directly relevant to §7/§8's findings (hardcoded encryption key,
disabled Dependabot, Java-legacy artifacts) — none of those appear to be resolved yet per this
checklist's own unchecked boxes.

### 9.6 `SECURITY.md` / `CODE_OF_CONDUCT.md` / `NOTICE` / `LICENSE`

Standard: security reports go privately to `vir@qable.io` (not a public issue); Apache-2.0
throughout; copyright QAble Testlab 2026.

### 9.7 Stray/orphan files worth a cleanup decision

- **`__t2`** — a zero-byte file at the repo root, no extension, unclear origin (shell-redirect typo,
  editor autosave, or forgotten scratch file). No discoverable purpose.
- **`Tesbo-Backend-Nest/src/__t3`** — a zero-byte file with no references anywhere in the backend
  source. Same likely origin as `__t2`.
Neither is referenced by any build/test/deploy tooling; both are candidates for deletion, but
confirm with the user before removing anything not obviously yours.

---

## 10. Cross-cutting footgun checklist (read before touching related code)

- **Never point anything at a local Postgres** — a stray `:5442` container will accept connections
  and lie. See §2.
- **e2e's `.env.example` still defaults to the public `:1010`/`:1011` port pair**, not this repo's
  `:1020`/`:1021` — override before running e2e locally. See §2.
- **`scripts/e2e-run.sh` and `scripts/load-run.sh` are macOS-only** — they will not run on this
  Windows machine as-is.
- **The hardcoded `SECRETS_ENCRYPTION_KEY` fallback in `docker-compose.yml`** must be overridden for
  any non-local/shared environment.
- **RBAC checks are inline and duplicated per call site** in `legacy.service.ts` — there is no
  guard/decorator to lean on; a new mutating endpoint must remember its own role check.
  Same for auth: `AuthMiddleware` only resolves identity, it doesn't reject unauthenticated callers.
- **The IDOR gap is real, tracked, and partially open** — `createSuite`/`createPlan`/`createCycle`
  and `listTestCases` currently accept callers with no (or zero) project access due to missing
  `@Req()` on those controller methods. See §5.5 / `api/authorization.spec.ts`.
- **Soft-delete views aren't universally used** — a new query against `testcases`/`executions` must
  explicitly filter `deleted_at IS NULL` or use the `_active` view; don't assume the base table is
  already filtered.
- **AI-key resolution logic exists in three separate places** (`LegacyService`, `rag-ai-allocation`,
  `integration-sync-decisions`) and can drift — check all three if changing key-resolution behavior.
- **`EmailDeliveryPolicy` can silently swallow sends** if `POSTMARK_API_TOKEN` is a Live token while
  `EMAIL_DELIVERY_MODE` is left at the default `log` — check `/api/admin/system/health`'s
  `email.reach`, not just whether a token is set.
- **`lib/api.ts` (frontend) is one 3,560-line file with no domain splitting** — grep for a function
  name rather than trying to browse to it; watch for the three distinct "runs" concepts (§4.3).
  `listTestCases` alone bypasses the shared fetch wrapper.
- **`proxy.ts` (frontend) is an intentional no-op** — do not add server-side auth gating there
  without first reading its comment; the cross-origin session cookie makes that approach fail.
- **`visualguideline.txt` describes an aspirational, not current, design system** — check
  `app/globals.css` and real components for actual tokens/nav/agent-count.
- **Dependabot is configured but effectively disabled** (`open-pull-requests-limit: 0` everywhere).
- **CONTRIBUTING.md's backend instructions are wrong** (describes a nonexistent Java/Maven service)
  — use `Tesbo-Backend-Nest/`'s own `README.md`/`package.json` instead.
- **Any change to product behavior needs e2e coverage that actually runs and passes** — this is a
  hard, explicit rule in [CLAUDE.md](CLAUDE.md), not optional, and not satisfied by unit tests or a
  type-check alone.
