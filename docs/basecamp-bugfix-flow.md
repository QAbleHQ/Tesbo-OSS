# Bug-fix flow, driven off the Basecamp board

How a reported bug gets from the board into `dev`. Written from what actually happened over ~30 cards,
including the parts that went wrong.

The short version: **a card is a claim, not a specification.** Most of the work is establishing what is
actually true before touching code, and the approval gate exists because roughly a third of cards turn
out not to need the fix they ask for.

---

## Board coordinates

The public share link (`public.app.basecamp.com/p/...`) is **not** parseable by `basecamp url parse`.
Use these ids.

| Thing | Id |
|---|---|
| Project (bucket) | `46336431` — TesboVerse |
| Card table | `9637160445` — the project has 3 tables, so `--card-table` is always required |
| Viral (assignee) | `44943233` |

Columns, in flow order:

| Column | Id |
|---|---|
| Triage | `9637160448` |
| Not now | `9637160449` |
| Specification | `10088772263` |
| To Do | `9637160451` |
| In progress | `9637160454` |
| Writing Tests | `10088778570` |
| Ready For the QA | `10203006394` |
| Ready for the the Deploy | `10207832539` |
| Ready for the Prod | `10207835842` |
| Done | `9637160457` |

```bash
basecamp cards list --column 9637160451 --card-table 9637160445 --in 46336431 --all --json
basecamp assign <card> --card --to 44943233 --in 46336431
basecamp cards move  <card> --to 9637160454 --in 46336431
basecamp comment     <card> "<p>…</p>" --in 46336431
```

---

## The loop

### 1. Claim it

Cards in To Do default to **Nikunj**. Assign to **Viral** *first* — before reading, before
investigating — so two people never work the same card. Then move it to **In progress**.

### 2. Read the report, not the title

Card titles drift from the defect. This is the single highest-value habit in the flow.

- Cards are BetterBugs exports; the body links `app.betterbugs.io/session/<id>`.
- `mcp__BetterBugs__getBugDetails` → repro steps and expected result.
- `mcp__BetterBugs__getBugLogs` → the failing request. Network logs name the endpoint and status.
- `mcp__BetterBugs__getScreenshot` → often the only thing that identifies the real field or screen.
- Attachments: `basecamp cards show <id> --in 46336431 --download-attachments=<dir>` (note the `=`;
  the space-separated form errors).

Two examples from real cards:

- *"Internal Server Error When Adding a Long Description"* — `description` is `TEXT` and cannot
  overflow. The screenshot showed the long text in the **Title** (`VARCHAR(512)`). Fixing the
  description would have fixed nothing.
- *"DRAFT count not updated after APPROVED"* — the counts were correct. The real defect was that the
  suite tree ignored cases belonging to no suite.

### 3. Categorise

Every card resolves to exactly one of these before any code is written.

| Verdict | What it means | Where it goes |
|---|---|---|
| **Bug** | Reproduced, or root cause proven in code | Fix → Writing Tests |
| **Already fixed** | Shipped or superseded; verify, then say so with evidence | Comment → out of To Do |
| **Duplicate** | Another card covers it | Merge, comment both |
| **Not a bug** | Works as designed; the reporter hit a knowledge gap | Comment with evidence, leave for the owner |
| **Unbuilt feature** | The UI advertises something the backend refuses | Hide the UI, or scope the feature |
| **Suggestion** | An enhancement, not a defect | Specification, with the open questions written down |

The two that catch people out:

**Features misread as bugs.** *"User session is not logged out after password change"* — `changePassword`
already revokes every *other* session, emails the user and audits it. Keeping your own browser signed in
is deliberate and matches GitHub and Google. Not a defect.

**Unbuilt UI read as broken.** *"Reports export buttons are not working"* — the button has no `onClick`,
`title="Coming soon"`, `cursor-not-allowed`. Working exactly as built. Same shape as Scheduled Runs,
where the backend throws `NotImplementedException` while the frontend ships a full schedule page. The fix
for these is to stop advertising the feature, not to patch the form.

### 4. Reproduce, and rank

Reproduce before claiming a mechanism. Prefer, in order: the BetterBugs evidence → local stack → the
code path with a proof (a unit assertion against the compiled service is worth more than an argument).

Severity is about blast radius, not annoyance: a 500 on a normal input, a crash, silent data loss and a
cross-tenant leak outrank anything cosmetic. Note explicitly when a card **cannot** be reproduced and
what is missing.

### 5. Get approval before fixing

Say what you are going to change and why, and wait. The ticket's framing is often not the right fix:

- Scope may be **wider** than the card — one card reported an unvalidated title; `testcases` had
  **14 unvalidated bounded columns**, each its own latent 500.
- Scope may be **narrower** — the card asked for schedule-form validation; the feature does not exist.
- The fix may be **removal** — a field that silently discarded everything typed into it, or a button
  that was never wired up.
- The card may encode a **behaviour decision** that is not yours to make (should linking a bug
  auto-fail the test case, or prompt?).

### 6. Fix, cover, then move

A change is not done until [e2e/](../e2e/) proves it. See [CLAUDE.md](../CLAUDE.md) for the mandate; the
run protocol in short:

- Map changed files to specs, announce the selection **and** the count before running.
- `scripts/e2e-run.sh <specs>` — ask first, `--workers=10`, in its own Terminal window.
- A failure is a product bug until proven otherwise. Never weaken a test to go green.

Then comment the outcome on the card and move it to **Writing Tests**. The comment should let the next
person skip the whole investigation: root cause, why the title was wrong if it was, what changed, what
proves it, and what is still unverified.

---

## Traps that have actually cost time

**Stale images.** Containers can be days behind `HEAD` and fail silently. Images once ran 5 days old.
Compare and rebuild before believing any red run:

```bash
docker compose images --format json   # Created
git log -1 --format=%cI              # HEAD
docker compose build backend frontend migrator && docker compose up -d
```

**Wrong port.** `Provisioned <user> but the follow-up password login still failed` is usually **not** an
auth bug. Invoking `npx playwright test` directly defaults `API_BASE_URL` to `:1011` — the open-source
stack. This stack is `:1020` / `:1021`. Use `scripts/e2e-run.sh`, which sets both.

**`audit_logs` is append-only.** Migration `V62` installs a trigger rejecting UPDATE and DELETE for every
role, and all three of its foreign keys are `ON DELETE SET NULL`. So **any row that has been audited can
never be hard-deleted** — Postgres tries to null the reference and the trigger refuses. Fixtures must
archive, not delete. One `DELETE FROM audit_logs` in a teardown produced 34 failures across four
unrelated specs. Use `execAllowingAuditImmutability` from [e2e/utils/psql.ts](../e2e/utils/psql.ts).

**Shared worktree.** Other sessions edit and commit the same tree. A typecheck error may be a colleague's
in-flight work, and a rebuild deploys it. Check `git status` before blaming your own change.

**Hooks after an early return.** A `useMemo` added *below* an `if (loading) return` changes React's hook
count between renders and crashes the page. This shipped once, on the plan detail screen, and someone
else had to fix it (`34f1bda`). Hooks go above every early return, always.

**Don't fix the product to suit a broken fixture.** When the suite failed en masse, the first instinct was
to change a foreign key. The product was right; the fixtures were wrong.
