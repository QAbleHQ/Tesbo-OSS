import { expect, test, type APIRequestContext } from "@playwright/test";
import { accountA, apiContext, ticket, unique } from "../fixtures";

/*
 * Reported-ticket regressions for the Zyra chat agent.
 *
 *   10231190735 / falsely confirms creation AND archiving with no repository change
 *   10231274688 / reports test cases as created in the same chat session, but none were created
 *   10231965612 / shows a technical "invalid JSON" error when generation fails
 *   10231923903 / a failure notice and "Created 7 test cases…" in the same response
 *
 * WHY THIS FILE REPLACED regression/ui/tickets-zyra.spec.ts.
 *
 * That file drove the chat through the browser and intercepted
 * `**\/agents/zyra/chat/sessions/*\/messages` with `route.fulfill()`, handing the UI a reply of its
 * own making. It then asserted that the SCREEN annotated the false claim. Both halves were wrong:
 *
 *   1. The fix is server-side. `reconcileZyraReply` rewrites the reply before it is stored or
 *      returned, so the browser never sees an unqualified false claim in the first place — there is
 *      nothing for the frontend to annotate. Intercepting the endpoint replaced exactly the code
 *      that contains the fix, so those tests could not pass however correct the product was. They
 *      carried `test.fail()` for that reason, which read as "the product is broken" when it was not.
 *   2. Card 10231923903 was recorded there as untestable — "the behaviour lives behind the provider
 *      call". The BetterBugs report shows both messages in ONE response: a failure notice followed
 *      by the router's own "Created 7 test cases covering passwordless biometric login…". That is
 *      product code composing two strings, and it is fixed in code that cites the card.
 *
 * WHAT IS ASSERTED HERE INSTEAD. The real endpoint, no interception, and an invariant that holds
 * whatever the model happens to say:
 *
 *   an assistant turn whose reply claims a mutation must either have PERSISTED something
 *   (a `testcases[]` entry carrying an `id`) or carry the correction that says it did not.
 *
 * `testcases[]` is the reliable record — `zyraTranscript` filters exactly this way when it tells the
 * next turn what really happened, and the sendZyraChatMessage path falls back to the model's merely
 * SUGGESTED rows (which have no id) when nothing was applied. So the check needs no knowledge of the
 * model's wording, and it is the same fact the product itself trusts.
 *
 * TWO HONEST LIMITATIONS, stated rather than worked around:
 *
 *   - These call a real provider. Where none is configured the agent answers `provider: "none"` and
 *     every test below skips, which is the state of stage today. They run wherever Zyra is actually
 *     enabled, which is where the cards were reported (app.tesbo.io).
 *   - There is no DELETE route for a chat session, so a run leaves its session behind. Sessions are
 *     named with the `E2E REG` prefix so they are identifiable, and any TEST CASE a turn creates is
 *     deleted in `finally` — that is the part that would otherwise pollute the repository.
 */

/**
 * Completion language, mirrored from LegacyService.ZYRA_COMPLETION_CLAIM.
 *
 * Past tense only, and only about the repository: "I'll create…" and "shall I archive…" are
 * proposals and must survive untouched, while "Created 7 test cases" and "PRO-TC-124 has been
 * archived" are claims about work the turn did not do. Duplicated deliberately — a test that
 * imported the product's own regex would pass by construction if that regex were weakened.
 */
const COMPLETION_CLAIM =
  /\b(created|added|generated and saved|saved|archived|updated|deleted|removed|moved)\b[^.!?\n]{0,80}\b(test\s?cases?|tc-\d|suite|repository)\b|\b(test\s?cases?|suite)\b[^.!?\n]{0,80}\b(have|has|were|was)\s+been\s+(created|added|saved|archived|updated|removed|moved)\b/i;

/** The corrections reconcileZyraReply prefixes when a reply outruns what the turn wrote. */
const CORRECTION = /Nothing was changed in the repository by this message|Nothing was saved|test case operation\(s\) were applied|nothing was created or saved/i;

type ChatMessage = {
  role: string;
  content: string;
  actionType?: string;
  testcases?: Array<{ id?: string; externalId?: string }>;
};

test.describe("zyra chat — reported tickets", () => {
  let api: APIRequestContext;
  let projectId: string;
  let skipReason: string | null = null;

  test.beforeAll(async () => {
    api = await apiContext();
    projectId = accountA().projectId;

    // The same probe api/zyra.spec.ts ZYR-A-07 relies on: a workspace with no key allocated answers
    // a normal payload carrying provider "none" rather than throwing, so this is a clean gate.
    const res = await api.get(`/api/projects/${projectId}/agents/zyra/test`, { failOnStatusCode: false });
    if (!res.ok()) {
      skipReason = `the Zyra agent state endpoint answered ${res.status()} on this environment`;
    } else {
      const body = await res.json();
      if (body.provider === "none" || body.ok === false) {
        skipReason =
          `no AI provider is configured on this environment (provider="${body.provider}"), so the chat ` +
          "path cannot be driven — these assertions need a real turn, not a stubbed one";
      }
    }
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test.beforeEach(() => {
    test.skip(skipReason !== null, skipReason ?? "");
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  async function openSession(label: string): Promise<string> {
    const res = await api.post(`/api/projects/${projectId}/agents/zyra/chat/sessions`, {
      data: { title: unique(label) },
    });
    expect(res.ok(), `could not open a chat session: ${res.status()} ${await res.text()}`).toBeTruthy();
    return (await res.json()).id;
  }

  async function say(sessionId: string, message: string): Promise<ChatMessage> {
    const res = await api.post(`/api/projects/${projectId}/agents/zyra/chat/sessions/${sessionId}/messages`, {
      data: { message },
      failOnStatusCode: false,
    });
    expect(res.status(), `sending "${message}" answered ${res.status()}: ${await res.text()}`).toBeLessThan(500);
    const body = await res.json();
    return (body.message ?? body) as ChatMessage;
  }

  async function turns(sessionId: string): Promise<ChatMessage[]> {
    const res = await api.get(`/api/projects/${projectId}/agents/zyra/chat/sessions/${sessionId}`);
    const body = await res.json();
    return (body.messages as ChatMessage[]).filter((m) => m.role === "assistant");
  }

  /** Every test case id this session actually persisted, so `finally` can remove them. */
  function persistedIds(messages: ChatMessage[]): string[] {
    return messages.flatMap((m) => (m.testcases ?? []).map((t) => t.id).filter((id): id is string => Boolean(id)));
  }

  async function removeTestcases(ids: string[]): Promise<void> {
    for (const id of ids) {
      await api.delete(`/api/projects/${projectId}/testcases/${id}`, { failOnStatusCode: false });
    }
  }

  /** The invariant, applied to one turn. Returns a readable explanation when it does not hold. */
  function claimIsHonest(turn: ChatMessage): { ok: boolean; why: string } {
    const reply = String(turn.content ?? "");
    const saved = (turn.testcases ?? []).filter((t) => t.id).length;
    if (!COMPLETION_CLAIM.test(reply)) return { ok: true, why: "no completion claim" };
    if (saved > 0) return { ok: true, why: `claim backed by ${saved} persisted row(s)` };
    if (CORRECTION.test(reply)) return { ok: true, why: "claim carries the correction" };
    return {
      ok: false,
      why:
        `a turn routed '${turn.actionType ?? "?"}' claimed a mutation, persisted nothing, and was not ` +
        `corrected. Reply was:\n${reply.slice(0, 600)}`,
    };
  }

  // ─── The tickets ───────────────────────────────────────────────────────────

  test(
    ticket("REG-ZYRA-01", "10231190735", "confirming a proposed change either carries it out or does not claim it did"),
    async () => {
      /*
       * The reporter's exact sequence, and the sharpest form of the defect. Zyra proposed archiving
       * PRO-TC-124 and TES-TC-1 and asked for confirmation; the user replied "yes"; Zyra answered
       * "Archiving PRO-TC-124 and TES-TC-1…" and nothing happened. Asked "is it created?" a moment
       * later, it read the same transcript and correctly said no — having already said yes.
       *
       * The confirmation is the hard part: "yes" only means something relative to the previous turn,
       * which is why the fix annotates a turn that was routed create/archive/update but wrote nothing
       * as a PROPOSAL still awaiting the go-ahead. This drives that whole shape and asserts the
       * invariant on every turn it produced — the proposal, the confirmation, and the follow-up.
       */
      const sessionId = await openSession("Zyra Confirm");
      let created: string[] = [];
      try {
        await say(sessionId, "Create two test cases for the login screen. Ask me to confirm before you save anything.");
        await say(sessionId, "yes");
        await say(sessionId, "is it created?");

        const assistantTurns = await turns(sessionId);
        created = persistedIds(assistantTurns);
        expect(assistantTurns.length, "the session recorded no assistant turns at all").toBeGreaterThan(0);

        for (const [i, turn] of assistantTurns.entries()) {
          const verdict = claimIsHonest(turn);
          expect(verdict.ok, `turn ${i + 1}: ${verdict.why}`).toBeTruthy();
        }
      } finally {
        await removeTestcases(created);
      }
    },
  );

  test(
    ticket("REG-ZYRA-02", "10231274688", "a second request in the same session is not reported as created unless it was"),
    async () => {
      /*
       * Card 10231274688: the first request really did create ten cases; a second request in the SAME
       * session answered "Created test cases covering the key knowledge-base items…" with no ids, no
       * confirmation and nothing in the repository. The session's own history is the aggravating
       * factor — an earlier turn that genuinely created rows is what makes the later claim plausible.
       *
       * So this deliberately asks twice, and holds the invariant on the SECOND turn specifically as
       * well as on all of them: a session where creation has already succeeded once must not let the
       * next reply inherit that success.
       */
      const sessionId = await openSession("Zyra Twice");
      let created: string[] = [];
      try {
        await say(sessionId, "Generate two test cases for the login endpoint covering success and an invalid password.");
        await say(sessionId, "create test cases for knowledge base");

        const assistantTurns = await turns(sessionId);
        created = persistedIds(assistantTurns);
        expect(assistantTurns.length, "expected a turn for each of the two requests").toBeGreaterThanOrEqual(2);

        for (const [i, turn] of assistantTurns.entries()) {
          const verdict = claimIsHonest(turn);
          expect(verdict.ok, `turn ${i + 1}: ${verdict.why}`).toBeTruthy();
        }

        // And the specific one the card is about — the later request, judged on its own record.
        const second = assistantTurns[assistantTurns.length - 1];
        const verdict = claimIsHonest(second);
        expect(verdict.ok, `the second request in the session: ${verdict.why}`).toBeTruthy();
      } finally {
        await removeTestcases(created);
      }
    },
  );

  test(
    ticket("REG-ZYRA-03", "10231965612", "no turn puts a parser diagnostic in front of the user"),
    async () => {
      /*
       * "⚠️ I couldn't produce the test cases this time (AI testcase generation returned invalid
       * JSON) — nothing was saved." The provider detail belongs in reasoningSummary and the activity
       * log; zyraFailureReply now maps it to a cause and an action the user can take.
       *
       * A failure cannot be forced here without interception — which is what made the old spec
       * meaningless — so this asserts the negative across every real turn the other cases produce
       * plus a request built to strain generation. It cannot prove the failure PATH is worded well
       * (zyra-reply-guards.spec.ts covers that directly, and is the right layer for it); it does
       * prove the vocabulary never reaches a user through the live endpoint.
       */
      const sessionId = await openSession("Zyra Jargon");
      let created: string[] = [];
      try {
        await say(sessionId, "Generate 40 exhaustive test cases covering every edge case of the entire product.");
        const assistantTurns = await turns(sessionId);
        created = persistedIds(assistantTurns);

        for (const [i, turn] of assistantTurns.entries()) {
          for (const jargon of [/invalid JSON/i, /SyntaxError/, /Unexpected token/i, /at position \d+/i]) {
            expect(
              String(turn.content ?? ""),
              `turn ${i + 1} showed the user a parser diagnostic matching ${jargon}`,
            ).not.toMatch(jargon);
          }
        }
      } finally {
        await removeTestcases(created);
      }
    },
  );

  test(
    ticket("REG-ZYRA-04", "10231923903", "an ungrounded request is answered once, not with a failure and a success"),
    async () => {
      /*
       * The reporter's own prompt, against a project whose knowledge base has no such feature. What
       * they saw was two contradictory messages in one response: the invalid-JSON failure notice,
       * and immediately after it the router's "Created 7 test cases covering passwordless biometric
       * login…". The cause was that a generation failure appended the router's reply, which on a
       * create routing is prose about work that did not happen.
       *
       * Two things are asserted. First, no single reply both announces a failure and claims success —
       * that combination is the defect regardless of which branch produced it. Second, if the turn
       * DID generate from general knowledge, it says so, because a reply that reads as coverage of
       * the team's own requirements when it came from the model's general knowledge is the other half
       * of this card.
       */
      const sessionId = await openSession("Zyra Ungrounded");
      let created: string[] = [];
      try {
        await say(sessionId, "Create test cases for passwordless biometric login.");
        const assistantTurns = await turns(sessionId);
        created = persistedIds(assistantTurns);
        expect(assistantTurns.length).toBeGreaterThan(0);

        for (const [i, turn] of assistantTurns.entries()) {
          const reply = String(turn.content ?? "");
          const announcesFailure = /couldn't finish this|couldn't produce|nothing was created or saved/i.test(reply);
          const claimsSuccess = COMPLETION_CLAIM.test(reply) && !CORRECTION.test(reply);
          expect(
            announcesFailure && claimsSuccess,
            `turn ${i + 1} both announced a failure and claimed success in one reply:\n${reply.slice(0, 600)}`,
          ).toBeFalsy();

          // The invariant still applies to this turn too.
          const verdict = claimIsHonest(turn);
          expect(verdict.ok, `turn ${i + 1}: ${verdict.why}`).toBeTruthy();
        }

        // If it generated anything at all, it has to name where the material came from.
        const savedSomething = created.length > 0;
        if (savedSomething) {
          const said = assistantTurns.some((t) =>
            /don't have anything about this in the project's knowledge base|from general practice|draft to review/i.test(
              String(t.content ?? ""),
            ),
          );
          expect(
            said,
            "cases were written for a feature the knowledge base knows nothing about, without saying so — " +
              "the reply reads as coverage of the team's requirements when it came from general knowledge",
          ).toBeTruthy();
        }
      } finally {
        await removeTestcases(created);
      }
    },
  );
});
