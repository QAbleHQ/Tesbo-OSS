# Zyra — agreed agent behaviour

The contract for how the Zyra chat agent behaves. Anything that changes behaviour described here is
a deliberate decision, recorded in the changelog at the bottom — not a silent edit.

Implementation: `Tesbo-Backend-Nest/src/legacy/legacy.service.ts` (`buildZyraChatDecision` and
below). Tests: `Tesbo-Backend-Nest/src/legacy/zyra-chat-intent.spec.ts`.

---

## 1. The pivot: the AI understands the request, the system performs the action

There is **no keyword router in front of the model**. One AI call reads the request in the context of
the conversation and the project and returns a structured decision; the backend validates it,
capability-gates it, executes it, and reconciles the reply against what actually happened.

```
message
  │
  ├─▶ gather context (always, before deciding anything)
  │     • knowledge base — semantic/RAG retrieval + folder-name lookup + recency floor
  │     • existing test cases — what is already covered
  │     • Jira tickets mentioned, project snapshot, suites, last generated batch
  │     • transcript, annotated with what each past turn actually persisted
  │
  ├─▶ AI router (one call) ──▶ { action, operations[], requestedCount, exhaustive, reply }
  │
  ├─▶ dispatch on the router's action
  │     create ─────────▶ generator call (own prompt, range instructions, draft schema)
  │     update/archive ─▶ operations against resolved test cases
  │     suite ──────────▶ create_suite / move_to_suite
  │     jira_pending ───▶ deterministic query, then AI writes the summary
  │     list/answer ────▶ reply only
  │
  ├─▶ applyZyraChatOperations — capability gates, real-entity validation, per-message cap, audit log
  │
  └─▶ finalizeZyraChatReply — table-only enforcement + mutation-claim reconciliation
```

**Why no keyword router:** a regex table cannot tell "start generating" from "generate", and cannot
know that "save it" means *create these* when the cases were never written and *move these* when
they were. It also silently overrode the model: a message classified `answer` had its operations
dropped, so the model's reply ("saved!") was published over zero writes. See the changelog.

The model decides. **The model never writes.**

## 2. Context first — always

Before Zyra proposes or authors anything it grounds itself in, in this order of preference:

1. **Knowledge base**, via `zyraGenerationContext`: folder-name lookup (for "the EAD-11215 folder"),
   semantic/RAG retrieval, and a recency snapshot as the floor. Gated by the `knowledgeBase`
   capability — off means the model is told it has no KB access and must not claim otherwise.
2. **Existing test cases** (`existingTestcaseSnapshot`) — coverage answers must come from these, not
   from guesses, and new cases must fill gaps rather than duplicate them.
3. **Jira tickets** named in the message, the project snapshot, and the suite list.

The same gatherer runs for the interactive turn **and for every background batch**. Batches re-read
context so batch N sees what batches 1..N-1 just wrote and does not duplicate it.

## 3. Configuration drives volume

Test case volume comes from Zyra → Settings → Test case range (`minimum`, `1-10`, `10-30`, `all`).

- The configured range is the default and is stated in the router prompt.
- An explicit user request wins: the router reports `requestedCount` (so "fifteen" works, not just
  "15") or `exhaustive: true` ("all possible cases", "as many as you can").
- A message-level regex remains as fallback only when the router reports neither.
- Hard ceiling of 25 per message (`ZYRA_CHAT_MAX_OPERATIONS`); anything above goes through batching.

## 4. Test cases appear in the table, and nowhere else

Generated and listed test cases go in the structured `testcases` array, which the UI renders as a
table (id, title, priority, status, first step, source). The `reply` gets a one-or-two-line summary.

This is **enforced, not requested**: `stripZyraTestcaseTables` removes markdown tables of test cases
from replies. Tables of other things (coverage per module, Jira comparisons) are legitimate prose and
are left alone. When a stripped table was the only record of cases that were never saved, the reply
says so and tells the user how to actually get them.

**There is no draft buffer.** Choosing `create` writes to the repository immediately. Zyra must never
call test cases "ready to save", never offer to save them later, and never enumerate cases it did not
create.

## 5. Batching for volume

Large asks are planned then executed in batches (`ZYRA_PLAN_BATCH_SIZE = 5`,
`ZYRA_PLAN_MAX_SCENARIOS = 40`) rather than one oversized call that truncates past the provider's
output ceiling and returns invalid JSON.

- Scenarios are planned first, then each batch is generated, saved, and posted as its own message.
- The plan is persisted (`zyra_chat_sessions.active_plan`), so it survives a backend restart and
  resumes on boot.
- A new user message supersedes an in-flight plan; the loop checks the plan id before each batch.
- The user can stop it; the plan **pauses** (keeping progress) and "continue" resumes it.
- The plan carries the routed suite, so every batch files into the suite the user asked for.

## 6. Failure is always graceful, and always honest

| Failure | Behaviour |
|---|---|
| No AI key allocated | Degraded mode: read-only requests answered from the repository (as table rows); mutations refused with the reason and where to fix it. |
| Router call fails | Same degraded mode, reason surfaced, logged as `zyra_chat_ai_failed` (`stage: routing`). |
| Generation fails after routing succeeded | Keep the router's answer, prefix that no cases were produced and nothing was saved. Logged with `stage: generation`. |
| Router response unusable/garbled | Treated as `answer` — never as a guessed mutation. |
| Batch fails mid-plan | Plan pauses with progress intact; "continue" retries. |
| A batch saves nothing | Reported as saving nothing, never as a successful batch. |
| Operations resolve to nothing | Visible activity entry, and the reply is corrected to "⚠️ Nothing was saved". |
| Capability disabled | Declined with the capability name and how to enable it — never silently substituted. |
| Operations exceed the per-message cap | Applied up to the cap, with the overflow reported (never silently truncated). |

**Never** report success for work that did not happen. `reconcileZyraReply` exists because the reply
is written before the operations run, so nothing else compares the claim to the outcome.

## 7. Guards that must not be removed

- Capability gates in `applyZyraChatOperations` — the final word regardless of what the model emitted.
- Operations may only reference test cases that actually resolve (`findProjectTestcase`,
  `resolveZyraMoveTargets`). `resolveZyraMoveTargets` never creates.
- An invented suite id is dropped; an invented suite name is allowed (suites are created by name).
- Archive is a status change, never a delete, and requires explicit confirmation first.
- `reconcileZyraReply` + `stripZyraTestcaseTables` on every outgoing reply.
- Hypothetical/exploratory questions ("what would happen if we deleted…") are `answer`, never action.

## 8. Changelog

| Date | Change | Reason |
|---|---|---|
| 2026-07-31 | Removed the keyword intent router from the live path; the AI router decides, keyword logic retained for degraded mode only (`zyraDegradedDecision`). | A regex classifier read "Yes, Please start generating" as small talk, so generation never ran; its `answer` classification then dropped the model's operations while its reply claimed success. |
| 2026-07-31 | Transcript annotated with what each assistant turn actually persisted. | The model cannot distinguish its own successful save from its own prose; "save it" was unresolvable without this fact. |
| 2026-07-31 | `requestedCount` / `exhaustive` reported by the router; suite resolved from the router's operation. | Digit-scraping regexes missed "fifteen"; substring suite matching missed "put them in Login". |
| 2026-07-31 | Test case markdown tables stripped from replies; rows required in `testcases`. | Cases the user could read but not open, run, or edit — and in one session they did not exist at all. |
| 2026-07-31 | Per-message operation cap raised 10 → 25 and overflow reported. | "Generate 15" saved 10 and reported 15. |
| 2026-07-31 | Zero-target `move_to_suite` records activity instead of returning silently. | A suite was created and left empty with no audit trail while the reply announced a successful save. |
| 2026-07-31 | Batches re-gather RAG/KB context and carry the routed suite. | Batches 2..N used a plain recency snapshot with no RAG and no capability gate, drifting from batch 1's sources. |
| 2026-07-31 | Generation failure after successful routing degrades to the router's answer. | A truncated generation response returned a bare "AI unavailable" and discarded an otherwise good turn. |
