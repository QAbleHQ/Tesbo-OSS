import { expect, test } from "@playwright/test";
import { accountA, ticket } from "../fixtures";

/*
 * Reported-ticket regressions for the Zyra chat agent — the four cards that refilled the board's
 * Writing Tests column:
 *
 *   10231274688 / 6a8c1fff  reports test cases as created in the session, but none were created
 *   10231190735 / 6a8c1891  falsely confirms creation AND archiving with no repository change
 *   10231965612 / 6a8c4d88  shows a technical "invalid JSON" error when generation fails
 *   10231923903 / 6a8c4ba2  gives contradictory answers for an unsupported request
 *
 * All four are one defect wearing four hats: the prose Zyra shows the user is not derived from what
 * it actually did. The product knows — sendZyraChatMessage's own prompt tells the next turn to "trust
 * the annotation over the wording of the reply, which may describe testcases that were never saved".
 * The annotation exists for the model; the human gets the wording.
 *
 * HOW THESE ARE TESTED WITHOUT A MODEL. api/zyra-chat-consistency.spec.ts covers the storage side of
 * this by seeding transcript rows through SQL, which this folder cannot do. Instead these intercept
 * the chat endpoint in the browser and hand the UI a reply of our choosing. That reaches the layer
 * where the reported defect is actually visible — what the user is told — and needs no provider, no
 * API key and no database, so it runs on any environment.
 *
 * It also does not create anything. The interception replaces the request, so no chat turn is stored
 * and no test case is written, which is what makes this safe to run in account A's shared project.
 *
 * Card 6a8c4ba2 is NOT covered here; see REG-ZYRA-04 for why.
 */

const CHAT_MESSAGES = /\/agents\/zyra\/chat\/sessions\/[^/]+\/messages$/;

test.describe("zyra chat — reported tickets", () => {
  /** Opens the chat and reports whether it can actually be driven on this environment. */
  async function openChat(page: import("@playwright/test").Page) {
    await page.goto(`/projects/${accountA().projectId}/agents/zyra`);
    const input = page.getByPlaceholder(/./).last();
    const send = page.getByRole("button", { name: /^(Send|Thinking\.\.\.)$/ });
    return { input, send };
  }

  test(
    ticket("REG-ZYRA-01", "10231274688", "a reply claiming it created cases is not shown as success when it created none"),
    async ({ page }) => {
      /*
       * EXPECTED RED until the reply the user reads is derived from the annotation.
       *
       * The intercepted turn is the exact contradiction the card describes: prose asserting that ten
       * test cases were created, alongside the structured `testcases: []` that says nothing was. The
       * product's own comment names this array as the reliable record, so the screen must not present
       * the prose as an accomplished fact while the record is empty.
       *
       * What "must not" means here is deliberately weak: SOMETHING has to mark the turn as having
       * written nothing — a note, a count, an absence of the created-cases list. Which of those is a
       * product decision (docs/e2e-coverage-waves.md §6c makes the same point about ZCC-A-03), so this
       * asserts only that the bare claim is not left standing unqualified.
       */
      test.fail();

      const { input, send } = await openChat(page);
      test.skip(
        await send.isDisabled(),
        "the Zyra agent is not active on this environment, so the chat cannot be driven",
      );

      await page.route(CHAT_MESSAGES, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            message: {
              role: "assistant",
              content:
                "Done — I've created 10 test cases covering the checkout flow and saved them to your repository.",
              // The annotation the product says to trust: nothing was written.
              testcases: [],
            },
          }),
        }),
      );

      await input.fill("Create 10 test cases for the checkout flow");
      await send.click();

      // The claim reaches the screen…
      await expect(page.getByText(/created 10 test cases/i)).toBeVisible();

      // …and must not stand as an unqualified success. Something has to say nothing was saved.
      await expect(
        page.getByText(/no test cases were (created|saved)|nothing was (created|saved)|0 test cases/i),
        "the reply claimed 10 cases while the turn recorded none — the screen must say so",
      ).toBeVisible();
    },
  );

  test(
    ticket("REG-ZYRA-02", "10231190735", "a reply claiming it archived cases is not shown as success when it archived none"),
    async ({ page }) => {
      // EXPECTED RED, same defect on the archiving path named by card 10231190735. Kept as its own
      // test because archiving is a different operation with its own annotation, and a fix scoped to
      // creation would leave this one reporting phantom work.
      test.fail();

      const { input, send } = await openChat(page);
      test.skip(
        await send.isDisabled(),
        "the Zyra agent is not active on this environment, so the chat cannot be driven",
      );

      await page.route(CHAT_MESSAGES, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            message: {
              role: "assistant",
              content: "I've archived the 4 outdated login test cases for you.",
              testcases: [],
            },
          }),
        }),
      );

      await input.fill("Archive the outdated login test cases");
      await send.click();

      await expect(page.getByText(/archived the 4 outdated/i)).toBeVisible();
      await expect(
        page.getByText(/no test cases were (archived|changed)|nothing was (archived|changed)/i),
        "the reply claimed 4 cases were archived while the turn recorded no change",
      ).toBeVisible();
    },
  );

  test(
    ticket("REG-ZYRA-03", "10231965612", "a failed generation is reported without a parser diagnostic"),
    async ({ page }) => {
      /*
       * Card 10231965612: the user is shown a technical "invalid JSON" error when generation fails.
       * This is the same class as docs/e2e-coverage-waves.md §6c's finding about lib/api.ts throwing
       * "Confirm NEXT_PUBLIC_API_URL, HTTPS, and CORS_ALLOWED_ORIGINS" as user-facing copy: a
       * developer diagnostic reaching the screen.
       *
       * Provoked by making the endpoint fail the way it would when a model returns something
       * unparseable. The assertion is on VOCABULARY, not on the exact sentence — the fix is free to
       * word the apology however it likes, but "JSON", "SyntaxError" and "Unexpected token" are never
       * things to say to a person using a test manager.
       */
      test.fail();

      const { input, send } = await openChat(page);
      test.skip(
        await send.isDisabled(),
        "the Zyra agent is not active on this environment, so the chat cannot be driven",
      );

      await page.route(CHAT_MESSAGES, (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            message: "Unexpected token < in JSON at position 0",
            error: "SyntaxError",
            statusCode: 500,
          }),
        }),
      );

      await input.fill("Generate test cases from the requirements document");
      await send.click();

      // Something must be said — silently swallowing the failure is its own defect.
      const notice = page.getByRole("alert").or(page.getByText(/couldn't|could not|failed|try again/i));
      await expect(notice.first()).toBeVisible();

      for (const jargon of [/JSON/i, /SyntaxError/, /Unexpected token/i, /position \d+/i]) {
        await expect(
          page.getByText(jargon),
          `the failure notice should not show the user "${jargon}"`,
        ).toHaveCount(0);
      }
    },
  );

  test(
    ticket("REG-ZYRA-04", "10231923903", "contradictory answers for an unsupported request"),
    async () => {
      /*
       * NOT COVERED, and skipped rather than faked.
       *
       * This card is about what the MODEL decides to say when asked for something Zyra cannot do —
       * whether one reply contradicts another within a session. Every path that makes that decision
       * (the router, the capability gates, the per-turn operation ceiling) runs behind the live
       * provider call: zyraCapabilityDisabled is invoked only AFTER zyraChatWithAnthropic /
       * zyraChatWithOpenAi return. Intercepting the endpoint, as the three tests above do, replaces
       * exactly the component whose behaviour is in question, so it could only ever assert the
       * fixture back to itself.
       *
       * The blocker is utils/fake-ai-server.ts — Wave 0 item 3 in docs/e2e-coverage-waves.md, still
       * the gap that prevents real Zyra behaviour testing. This placeholder exists so the card has a
       * home and so `grep -rn 10231923903 e2e/` finds an honest answer instead of nothing.
       */
      test.skip(
        true,
        "needs utils/fake-ai-server.ts (tracker Wave 0 item 3): the behaviour under test lives behind " +
          "the provider call, so route interception would assert the fixture rather than the product",
      );
    },
  );
});
