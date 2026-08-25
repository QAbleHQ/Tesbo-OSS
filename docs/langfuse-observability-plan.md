# Langfuse integration plan — full traceability for Zyra and every other model call

Status: **proposal, awaiting approval.** Nothing in this document has been implemented.

Scope: end-to-end observability (traces, token/cost accounting, quality scores) over every LLM and
embedding call the product makes, without changing what Zyra does.

---

## 1. Why — the concrete gaps in what we have today

This is not a generic "observability is good" argument. Each item below is a thing we currently
**cannot answer** about our own production behaviour.

### 1.1 There are nine model call sites and none of them are correlated

| # | Call site | File / line | Traced today |
|---|-----------|-------------|--------------|
| 1 | Zyra chat router | `legacy.service.ts:11010` `zyraChatWithOpenAi` / `:11040` `zyraChatWithAnthropic` | no |
| 2 | Tool-decision finalizer | `legacy.service.ts:9496` `finalizeZyraToolDecisionWithAi` | no |
| 3 | Scenario planner | `legacy.service.ts:10796` `planZyraChatScenarios` → `:10743` `zyraJsonCompletion` | no |
| 4 | Testcase generator (OpenAI wire) | `legacy.service.ts:10822` `generateZyraWithOpenAi` | usage parsed, then discarded |
| 5 | Testcase generator (Anthropic wire) | `legacy.service.ts:10878` `generateZyraWithAnthropic` | usage parsed, then discarded |
| 6 | Agent memory summariser | `legacy.service.ts:10047` `summarizeForZyraMemory` | no |
| 7 | Knowledge-file transcription | `legacy.service.ts:6960` `transcribeKnowledgeFile` (audio → text) | no |
| 8 | RAG embeddings | `rag/rag-ai-allocation.ts:44` `embedTexts` | no |
| 9 | Integration sync decisions | `integration-sync/integration-sync-decisions.ts:131` / `:160` | no |

(`testZyraAiConnection` at `legacy.service.ts:8316` is a health probe — deliberately excluded, it
would be pure noise.)

### 1.2 A single user message fans out to up to four sequential model calls, invisibly

From `docs/zyra-agent-behaviour.md` and the code, one chat turn runs:

```
sendZyraChatMessage
  └─ buildZyraChatDecision            (legacy.service.ts:8642)
       ├─ 8 parallel context fetches  (RAG, KB folders, Jira, existing testcases, snapshot, history)
       ├─ AI call #1  router          (:8756)
       └─ AI call #2  finalizer       (:8761)  — conditional
  └─ startZyraChatPlan                (:9269)
       ├─ AI call #3  scenario plan   (:9287)  — conditional, exhaustive requests only
       └─ AI call #4..N generator     (:9303, :9323, :9423) — one per batch
  └─ applyZyraChatOperations          (:8904)  — what actually got written
  └─ rememberZyraTurn                 (:10083) — AI call N+1, memory summary
```

When a user reports "Zyra said it saved 20 cases and I see none," we currently have the reply text
and an activity JSON blob. We do not have: which prompt went out, what the router decided, what RAG
actually retrieved, which batch failed, or how many tokens it burned. That exact class of bug is
what the changelog in `docs/zyra-agent-behaviour.md` is largely made of.

### 1.3 We throw away the token usage we already parse

`generateZyraWithOpenAi` (`:10866`) and `generateZyraWithAnthropic` (`:10930`) both extract
`{ input, output, total, cached }`. The only thing that is ever done with it is interpolating
`cached` into a prose activity string at `legacy.service.ts:9833`:

```ts
detail: `Updated this task with ${aiResult.drafts.length} regenerated draft(s). Cached input tokens: ${aiResult.usage.cached}.`
```

There is no table, no aggregate, no per-workspace figure. **We cannot currently answer "what did
Zyra cost us last month" or "which workspace is burning the most tokens" at all** — which matters
because keys are allocated per project (`project_ai_key_allocations` → `workspace_ai_keys`) and
plan gating is a paid-tier concern.

The other seven call sites do not even parse usage.

### 1.4 Background plans survive process restarts and are completely dark

`resumeInterruptedZyraChatPlans` (`legacy.service.ts:843`) picks up `zyra_chat_sessions.active_plan`
rows with `status = 'running'` after a restart and resumes them via `continueZyraChatPlan`
(`:9382`). Those batches run outside any HTTP request. Today they produce no correlatable record
whatsoever.

### 1.5 RAG retrieval quality is unmeasurable

`ragRetrieval.retrieveKnowledgeContext` is called at `legacy.service.ts:8660` and is documented as
"never throws, resolves to `[]` on any failure." That is the right resilience choice and a terrible
observability one: a silently-empty retrieval is indistinguishable from a working one, and it is the
single most likely cause of Zyra answering from guesswork instead of the knowledge base.

### 1.6 We have quality signal and we don't use it

- `zyraFeedback` (`:9762`) collects free-text review feedback → stored as a `feedback` column.
- `ai_generation_requests` (migration `V8`) already tracks `generated_count` **and** `saved_count`.
  The ratio is a genuine draft-acceptance metric. Nobody looks at it.
- `zyraDeleteDraft` (`:9890`) is an explicit per-draft rejection signal. Discarded.

---

## 2. Decisions I need from you before any code

### D1 — Hosting: self-hosted vs Langfuse Cloud  ← the one that actually matters

Our prompts contain, verbatim: customer knowledge-base documents, Jira ticket bodies, existing test
cases, and raw user messages, across **real workspaces on shared infrastructure**. Sending that to a
third party is a subprocessor decision, not an engineering one.

| Option | Pros | Cons |
|--------|------|------|
| **A. Self-host** (docker compose) | No third party sees customer data. No DPA, no privacy-policy update, no subprocessor disclosure. Full retention control. | New infra: Langfuse needs Postgres + **ClickHouse** + Redis + S3-compatible blob storage. We already run Redis and have Spaces/S3; ClickHouse is genuinely new to operate. |
| **B. Langfuse Cloud (EU)** | Zero ops. Fastest to value. | Customer prompt content leaves our infrastructure. Requires DPA + subprocessor listing. |
| **C. Cloud + full input/output masking** | No content leaves. | Kills ~80% of the value — you get latency and token counts but cannot debug a bad answer, which is the main reason to do this. |

**My recommendation: A (self-host).** The ops cost is real but bounded, and it removes the
customer-data conversation entirely. We already run a compose stack with Redis; the incremental
operator burden is ClickHouse plus a volume.

A reasonable middle path if you want speed: **Cloud for local/dev only** (where data is synthetic
e2e tenants) and **self-hosted for production**. Same SDK, different `LANGFUSE_BASEURL`.

### D2 — Do we trace production, or staging only, to begin with?

I would enable it in production from day one, behind `LANGFUSE_ENABLED`, because the bugs we want to
see are production bugs. Staging traffic is us, and we already know what we typed.

### D3 — Retention

Traces carry customer content. Suggest 30 days for full traces, indefinite for the aggregated
cost/score metrics. Needs your call, especially if any customer contract says otherwise.

---

## 3. Architecture — how it plugs into a codebase with no LLM SDK

**Important: we do not need and should not adopt LangChain.** Langfuse's headline "one-line
integration" is an OpenAI-SDK wrapper or a LangChain callback handler. We use neither — every call
is a raw `fetch` against a provider-shaped URL built by `providerChatUrl` /
`normalizeAnthropicMessagesUrl`. That multi-provider abstraction (openai · anthropic · azure ·
gemini · openrouter · custom, per `legacy.service.ts:488-580`) is better suited to our product than
anything LangChain would give us, and swapping to it would be a rewrite of a 12,000-line service to
gain nothing. **We instrument manually.** That is a supported, first-class Langfuse path.

### 3.1 New module: `Tesbo-Backend-Nest/src/observability/`

```
observability/
  observability.module.ts       # global module, registered in app.module.ts
  langfuse.service.ts           # SDK lifecycle: init, shutdown, forceFlush
  ai-trace.service.ts           # the API the rest of the codebase calls
  ai-trace.types.ts             # TraceContext, GenerationRecord, UsageRecord
  redaction.ts                  # secret stripping — see §7
  ai-trace.service.spec.ts      # unit tests (no network)
  redaction.spec.ts
```

`AiTraceService` exposes roughly three things, and nothing else touches the SDK:

```ts
// Opens a trace for one user turn. Returns a handle; never throws.
startTurn(ctx: { organizationId, projectId, userId, sessionId, messageId, input }): TurnHandle

// Wraps any non-LLM work worth seeing (RAG retrieval, Jira snapshot, applying operations).
observeSpan<T>(handle, name, fn: () => Promise<T>, opts?): Promise<T>

// Wraps one model call: records model, provider, prompt, completion, usage, latency, error.
observeGeneration<T>(handle, name, meta, fn: () => Promise<T>): Promise<T>
```

Call sites change by ~4 lines each — no restructuring of `legacy.service.ts`.

### 3.2 SDK choice — needs verification at install

The Langfuse JS/TS SDK changed shape between majors: v3 is the standalone `langfuse` package
(`langfuse.trace()` / `.generation()`); v4 is OpenTelemetry-based (`@langfuse/tracing` +
`@langfuse/otel` over `@opentelemetry/sdk-node`, using `startObservation()` / `observe()`).

I lean **v4/OTel**, because OTel context propagation solves our hardest correlation problem for free
— a trace started in an HTTP handler stays attached through `await`s into `startZyraChatPlan` — and
because it gives us HTTP and `pg` spans as a bonus.

I will pin the exact version and confirm the API surface against the current docs before writing
code rather than guessing from memory. If v4's OTel bootstrap turns out to fight NestJS lifecycle
ordering, v3's explicit API is the fallback and costs us only the automatic propagation.

### 3.3 The trace model

This is the part worth getting right, because it is what makes the data useful.

```
Langfuse session   ←→  zyra_chat_sessions.id          (whole conversation replays as one session)
Langfuse user      ←→  users.id
Langfuse tags      ←→  [provider, model, action_type, plan_tier]
Langfuse metadata  ←→  { organizationId, projectId, capabilities, testcaseRange }

trace  "zyra.chat.turn"                       ←→ one zyra_chat_messages row (the user turn)
  ├─ span        gather-context
  │    ├─ span        rag-retrieval            → retrieved doc ids + scores + count  (§1.5)
  │    ├─ span        knowledge-folder-lookup
  │    ├─ span        jira-snapshot
  │    └─ span        existing-testcases
  ├─ generation  router                        → model, prompt, decision JSON, usage, cost
  ├─ generation  finalize-tool-decision        (conditional)
  ├─ span        plan
  │    └─ generation  scenario-plan            (conditional — exhaustive requests)
  ├─ span        generate-batch  ×N
  │    └─ generation  testcase-generation      → drafts, usage incl. cached tokens
  ├─ span        apply-operations              → what was ACTUALLY persisted
  └─ span        remember-turn
       └─ generation  memory-summary

trace  "zyra.task.generate"                   ←→ one ai_generation_requests row
trace  "rag.ingest"                           ←→ one embedding job (BullMQ)
trace  "integration.sync.decision"            ←→ one sync decision
```

The `apply-operations` span sitting next to the `router` generation in the same trace is the
highest-value pairing in this whole design: it puts *what the model claimed* and *what the database
actually did* side by side on one screen. That is the mutation-claim reconciliation problem from
`docs/zyra-agent-behaviour.md` §1, made visible — and in Phase 4 it becomes an automated score.

---

## 4. Phased implementation

### Phase 0 — Decisions and a throwaway spike (~0.5 day)

- Answer D1/D2/D3.
- Stand up Langfuse (self-hosted compose or a cloud project) and push one hand-rolled trace from a
  scratch script to confirm SDK version, auth, and the nested-observation API.
- **Deliverable:** confirmed package + version pin. No repo changes.

### Phase 1 — Module + the Zyra chat path (~2–3 days)

Highest value, smallest blast radius. Touches one code path.

1. `src/observability/` module as in §3.1, registered globally in `app.module.ts`.
2. `AppConfigService` additions (§6) — inert when `LANGFUSE_ENABLED` is false.
3. Instrument, in this order:
   - `sendZyraChatMessage` (`:8495`) — opens the trace
   - `buildZyraChatDecision` (`:8642`) — context spans + router generation
   - `finalizeZyraToolDecisionWithAi` (`:9496`)
   - `startZyraChatPlan` / `continueZyraChatPlan` (`:9269` / `:9382`)
   - `generateZyraChatTestcasesWithAi` (`:9103`) → `generateZyraWithProvider` (`:10484`)
   - `applyZyraChatOperations` (`:8904`)
4. Migration **V84** (§5) — persist `trace_id`.
5. Shutdown flush in `main.ts` (§8).
6. e2e coverage per §9, run and green.

### Phase 2 — The remaining call sites (~1 day)

`summarizeForZyraMemory`, `transcribeKnowledgeFile`, `embedTexts` (inside the BullMQ
`RagEmbeddingProcessor`), and `integration-sync-decisions`. The RAG one needs per-job flush because
a worker can be the last thing alive before scale-down.

Also: extend usage parsing to the sites that don't do it (`zyraJsonCompletion`, `zyraChatWith*`,
`summarizeForZyraMemory`), so cost is complete rather than partial.

### Phase 3 — Scores and evals (~1–1.5 days)

This is where it stops being a log viewer and becomes a quality system.

| Score | Source | Type |
|-------|--------|------|
| `user_feedback` | `zyraFeedback` (`:9762`) | free-text + categorical |
| `draft_acceptance` | `ai_generation_requests.saved_count / generated_count` | numeric 0–1 |
| `draft_rejected` | `zyraDeleteDraft` (`:9890`) | boolean, per draft |
| `mutation_claim_consistency` | reply claims vs `applyZyraChatOperations` result | boolean, automated |
| `rag_hit` | retrieval returned ≥1 doc when KB capability was ON | boolean, automated |
| `router_action` | `action_type` distribution over time | categorical, drift alarm |

The last three are computed by us and pushed as scores — no LLM-as-judge needed, no extra cost.

### Phase 4 — Dashboards and alerts (~0.5 day)

Cost per workspace/project/model; p50/p95 latency per call site; error rate by provider (feeds the
existing `describeProviderError` categories: auth / permission / rate-limit); RAG hit rate;
draft-acceptance trend. Alert on error-rate and cost anomalies.

### Phase 5 — Prompt management — **I recommend deferring this**

Langfuse can host `zyraSystemPrompt()` (`:10499`), `zyraStaticSourcePrompt()` (`:10511`),
`zyraDynamicTaskPrompt()` (`:10550`) and the ~60-line inline context array in
`buildZyraChatDecision`, giving versioning and rollback without a deploy.

Two reasons to hold off:

1. It puts Langfuse in the **critical path** — Zyra stops working correctly if the prompt fetch
   degrades. Mitigable with cache + in-code fallback, but it is a new failure mode for zero
   observability gain.
2. It conflicts with `docs/zyra-agent-behaviour.md` being the contract of record. Prompts moving to
   an external UI means behaviour can change without a changelog entry — precisely what that doc and
   our working agreement exist to prevent.

Revisit once we are actually iterating on prompts weekly.

---

## 5. Schema change — migration V84

Latest migration is `V83_bugs_priority.sql`, so this is `V84_ai_trace_ids.sql`:

```sql
ALTER TABLE zyra_chat_messages     ADD COLUMN IF NOT EXISTS trace_id VARCHAR(64);
ALTER TABLE ai_generation_requests ADD COLUMN IF NOT EXISTS trace_id VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_zyra_chat_messages_trace ON zyra_chat_messages(trace_id)
  WHERE trace_id IS NOT NULL;
```

Nullable, additive, idempotent, no backfill. Purpose: a support report ("Zyra misbehaved at 15:40")
becomes one SQL query to the exact trace, instead of a timestamp hunt in the Langfuse UI.

Plan continuation across restarts needs **no** column — `zyra_chat_sessions.active_plan` is already
`JSONB` and already survives restarts, so the trace id rides inside it and
`resumeInterruptedZyraChatPlans` reattaches to the original trace automatically.

Per `CLAUDE.md`, a migration requires e2e coverage even though no endpoint visibly changes. Covered
in §9.

---

## 6. Configuration

Added to `AppConfigService`, following the existing pattern:

```ts
readonly langfuseEnabled     = this.boolean("LANGFUSE_ENABLED", false);   // default OFF
readonly langfusePublicKey   = this.string("LANGFUSE_PUBLIC_KEY", "");
readonly langfuseSecretKey   = this.string("LANGFUSE_SECRET_KEY", "");
readonly langfuseBaseUrl     = this.string("LANGFUSE_BASEURL", "https://cloud.langfuse.com");
readonly langfuseSampleRate  = this.number("LANGFUSE_SAMPLE_RATE", 1.0);
readonly langfuseFlushAtMs   = this.integer("LANGFUSE_FLUSH_INTERVAL_MS", 5_000);
readonly langfuseEnvironment = this.string("LANGFUSE_ENVIRONMENT", "development");
```

- **Default `false`.** e2e runs, local dev, and the open-source fork are unaffected unless
  explicitly switched on. `LANGFUSE_SECRET_KEY` goes in `.env` (never committed) and
  `docker.env.example` gets documented placeholders.
- **`LANGFUSE_ENVIRONMENT`** must differ between local / staging / production or the traces mix and
  the cost dashboards become meaningless.
- Sampling at 1.0 to start — our volume does not warrant sampling, and sampled traces are worse than
  useless for debugging a specific user's complaint.
- The module keeps the OSS fork clean: with no keys set it never initialises the SDK.

---

## 7. Security — the trap that will bite us if we are careless

**The `key` object passed to almost every AI helper contains the plaintext provider API key.**

Look at the signatures: `zyraJsonCompletion(provider, model, key: Body, ...)`,
`zyraChatWithOpenAi(key: Body, ...)`, `generateZyraWithProvider({ apiKey, ... })`. A well-meaning
`input: params` on a generation observation would ship a live — and per our notes, sometimes
**production** — provider key straight into the trace store.

Mitigations, all in `redaction.ts`, all unit-tested:

1. **Allowlist, never denylist.** The tracing layer accepts only explicitly named fields. It never
   receives a `key`/`params` object and picks fields out of it.
2. A **final regex sweep** over every serialised payload for `sk-`, `sk-ant-`, `Bearer `,
   `x-api-key`, and the `SECRETS_ENCRYPTION_KEY` value, replacing hits with `[REDACTED]`. Belt and
   braces — the allowlist should make this unreachable, and it stays anyway.
3. **Never trace headers.** `providerAuthHeaders` output is off-limits, full stop.
4. An e2e assertion that captured ingestion payloads contain no key material (§9, scenario 5).

Beyond keys: trace content is customer data, which is what makes D1 the decision it is. Whatever we
choose, `LANGFUSE_ENVIRONMENT` must isolate production traces and retention must be finite.

---

## 8. Failure isolation — Langfuse must never be able to break Zyra

Non-negotiable, and cheap to guarantee:

- Every `AiTraceService` method is internally `try/catch`ed and returns a no-op handle on failure.
  A tracing bug produces a log line, never a 500.
- **No blocking flush on the request path.** Background batching only; the user never waits on
  Langfuse.
- A dead or slow Langfuse must not add latency — short ingestion timeout, drop on failure.
- **Flush on shutdown.** `main.ts` needs `app.enableShutdownHooks()` plus `forceFlush()` in
  `onApplicationShutdown`, otherwise every container restart silently drops the last few seconds of
  traces — and container restarts are exactly when the interesting traces happen.
- **BullMQ processors flush per job** (`RagEmbeddingProcessor`, `IntegrationSyncProcessor`), since a
  worker can exit right after finishing.
- Circuit-break: after N consecutive ingestion failures, disable for a cooldown rather than
  retrying into a wall.

---

## 9. e2e coverage — Phase 1 of the mandate, enumerated up front

Per `CLAUDE.md`, this ships with real, run, passing e2e tests. Listing the scenarios before writing
them, as required.

**Test harness note:** rather than depend on a live Langfuse, the specs point `LANGFUSE_BASEURL` at
a local HTTP stub that captures ingestion bodies. That makes trace emission assertable, keeps the
suite hermetic, and lets us simulate outages and bad credentials deterministically.

### Primary scenario
1. Chat message with tracing on → reply is byte-identical to the untraced reply; `trace_id` is
   persisted on the `zyra_chat_messages` row; the stub received a trace whose span names match the
   §3.3 tree.

### Surrounding scenarios
2. Tracing **disabled** → behaviour and response identical, `trace_id` is `NULL`, stub received
   nothing.
3. Testcase generation task (`zyraTask` / `processZyraTask`) → `ai_generation_requests.trace_id`
   populated.
4. Background plan: start an exhaustive plan → batches from `continueZyraChatPlan` land under the
   **same** trace and session, not orphans.
5. Draft save / delete flows still behave identically with tracing on.

### Edge cases
6. **Langfuse unreachable** (stub refuses connections) → Zyra answers normally, no user-visible
   error, latency within budget.
7. **Langfuse returns 500 / 401** (bad credentials) → same.
8. **No AI key allocated** → `zyraDegradedDecision` path, no trace emitted, no crash.
9. **Secret leakage**: assert no captured payload contains `sk-`, `sk-ant-`, `Bearer `, or the
   allocated key's value. ← the §7 guard.
10. **Authorization**: unauthenticated caller gets the unchanged 401 and emits no trace.
11. **Cross-tenant**: account B's traces carry B's `organizationId`/`projectId`; nothing from
    account A appears in B's metadata.
12. **Plan gating**: a read-only/downgraded workspace behaves identically with tracing on.
13. **Empty / whitespace-only message** → unchanged validation response.
14. **Concurrency**: two sessions in parallel do not cross-attach spans (the real risk in an
    OTel-context design, and the reason this scenario exists).
15. **Migration**: V84 applies cleanly, is idempotent on re-run, existing rows unaffected,
    `trace_id` nullable.
16. **Session cleanup**: deleting a project cascades chat sessions; no orphan/FK error from the new
    column.

### Impacted specs
- `e2e/api/zyra.spec.ts` — extend (primary owner)
- `e2e/ui/zyra.spec.ts` — extend (scenarios 1, 5)
- `e2e/api/knowledge-base.spec.ts` — Phase 2, RAG embedding traces
- `e2e/api/integrations.spec.ts` — Phase 2, sync-decision traces
- `e2e/api/authorization.spec.ts` — scenarios 10, 11

Selection will be announced with `--list` counts and run at `--workers=10` in its own Terminal
window via `scripts/e2e-run.sh`, **after** asking — per the standing protocol.

---

## 10. What I would deliberately *not* do

- **Not adopt LangChain.** Worth stating plainly since the two names get conflated: Langfuse needs
  no LangChain. Our provider layer already does more than LangChain would, and adopting it means
  rewriting a 12,000-line service for negative benefit.
- **Not put Langfuse in the request critical path** — no blocking flush, no prompt fetch on the hot
  path (see Phase 5).
- **Not trace the health probe** `testZyraAiConnection` — noise that would skew every error-rate
  panel.
- **Not build our own tracing tables.** We already have `ai_generation_requests` doing a fraction of
  this badly; extending it into a homegrown observability store is a year of work Langfuse has
  already done.
- **Not sample below 100%** until volume forces it.

---

## 11. Effort

| Phase | Estimate |
|-------|----------|
| 0 — decisions + spike | 0.5 d |
| 1 — module + Zyra chat path + V84 + e2e | 2–3 d |
| 2 — remaining call sites + complete usage parsing | 1 d |
| 3 — scores and evals | 1–1.5 d |
| 4 — dashboards and alerts | 0.5 d |
| 5 — prompt management | deferred |
| **Total to full value (0–4)** | **5–6.5 days** |

Plus, if self-hosting: standing up and operating Langfuse's ClickHouse/Postgres/Redis/S3 stack —
not included above, since it depends on D1.

---

## 12. What I need from you

1. **D1** — self-host or cloud? (My recommendation: self-host, or cloud-for-dev + self-host-for-prod.)
2. **D2** — production tracing from day one? (My recommendation: yes.)
3. **D3** — retention window for trace content.
4. Approval to start **Phase 0 + Phase 1**. I would not build past Phase 1 before you have looked at
   real traces and confirmed they show you what you actually wanted.

---

## Changelog

- **2026-08-25** — Plan drafted from a survey of the nine live model call sites. No code changes.
