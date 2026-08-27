import { expect, test, type APIRequestContext } from "@playwright/test";
import { accountA, cleanup, createTestCase, ticket, unique } from "../fixtures";

/*
 * Reported-ticket regression for test suite creation.
 * Card 10217475765, BetterBugs 6a85825a — "Geeting error page while creating test suit and clicking
 * test suit".
 *
 * WHAT THE EVIDENCE ACTUALLY SUPPORTS, stated plainly because it is thin. This card carries no
 * usable report: the BetterBugs session records 0 network requests, 0 console logs and 0 user steps,
 * its description is a copy of its title, and the page it was filed from is `/plans`, not a suites
 * screen. So there is no repro, no failing request and no stack — nothing that identifies which
 * input produced an error page. docs/basecamp-bugfix-flow.md's rule applies: say so rather than
 * inventing a mechanism.
 *
 * What CAN be done without guessing is to pin the contract the phrase "error page" would violate.
 * An error page on this path means one of two things — the create request answered 5xx, or the
 * follow-up read of the suite did — so these tests drive create and read across the inputs most
 * likely to produce an unhandled server error, and assert that every answer is a deliberate one.
 * A 400 is a pass here: the complaint is a crash, not a refusal.
 *
 * If a future report arrives with real evidence, the specific case belongs in api/suites.spec.ts
 * alongside the rest of the suite CRUD coverage; this file stays the ticket's own record.
 */

test.describe("test suite creation — reported ticket 10217475765", () => {
  const NEVER_5XX = "no input should make this answer 5xx — that is what an error page looks like";

  test(
    ticket("REG-SUITE-01", "10217475765", "a suite can be created and then read back"),
    { tag: '@tesbo.testId("TES-TC-1243")' },
    async ({ request }) => {
      // The plain path first. If this ever breaks, every other test here is noise.
      const projectId = accountA().projectId;
      const name = unique("Suite");

      const created = await request.post(`/api/projects/${projectId}/suites`, { data: { name } });
      expect(created.status(), NEVER_5XX).toBeLessThan(500);
      expect(created.ok()).toBeTruthy();
      const suite = await created.json();

      try {
        // "Clicking the suite" is a read of the project's suite list plus its test cases — the two
        // requests the screen makes. Both must answer cleanly.
        const list = await request.get(`/api/projects/${projectId}/suites`);
        expect(list.status(), NEVER_5XX).toBeLessThan(500);
        expect(list.ok()).toBeTruthy();
        expect((await list.json()).some((s: { id: string }) => s.id === suite.id)).toBeTruthy();

        const cases = await request.get(`/api/projects/${projectId}/testcases`, {
          params: { suiteId: suite.id },
          failOnStatusCode: false,
        });
        expect(cases.status(), NEVER_5XX).toBeLessThan(500);
      } finally {
        await cleanup(request, [`/api/suites/${suite.id}`]);
      }
    },
  );

  test(
    ticket("REG-SUITE-02", "10217475765", "hostile suite names are refused or accepted, never crashed on"),
    { tag: '@tesbo.testId("TES-TC-1244")' },
    async ({ request }) => {
      /*
       * The inputs that turn a missing length check or a bad cast into a 500. This is the shape the
       * board has produced before: card 10230861650 was an "Internal Server Error" on a long project
       * name, and docs/basecamp-bugfix-flow.md records a card blamed on a TEXT description whose real
       * cause was a VARCHAR(512) title. Suites take a name from the same kind of column, so the same
       * class of defect is the most probable reading of this card.
       *
       * Each case asserts only that the answer is DELIBERATE — below 500. Whether a 900-character
       * name should be truncated, refused with a 400, or stored is a product decision, and pinning
       * one here would be inventing a requirement the card does not state.
       */
      const projectId = accountA().projectId;
      const created: string[] = [];

      const names: Array<{ label: string; value: unknown }> = [
        { label: "900 characters", value: `${unique("Long")} ${"x".repeat(900)}` },
        { label: "exactly 512 characters", value: "y".repeat(512) },
        { label: "whitespace only", value: "   " },
        { label: "empty", value: "" },
        { label: "emoji and combining marks", value: `${unique("Unicode")} 🧪 é ñ` },
        { label: "SQL-ish quoting", value: `${unique("Quote")} '); DROP TABLE suites;--` },
        { label: "angle brackets", value: `${unique("Markup")} <script>alert(1)</script>` },
        { label: "a number, not a string", value: 12345 },
        { label: "null", value: null },
      ];

      try {
        for (const { label, value } of names) {
          const res = await request.post(`/api/projects/${projectId}/suites`, {
            data: { name: value },
            failOnStatusCode: false,
          });

          expect(res.status(), `${label}: ${NEVER_5XX}`).toBeLessThan(500);

          // Anything that WAS accepted has to be readable afterwards — a row that cannot be listed
          // is exactly how "create worked, clicking it fails" happens.
          if (res.ok()) {
            const body = await res.json();
            created.push(body.id);
            const list = await request.get(`/api/projects/${projectId}/suites`);
            expect(list.status(), `${label}: listing after create: ${NEVER_5XX}`).toBeLessThan(500);
            expect(
              (await list.json()).some((s: { id: string }) => s.id === body.id),
              `${label}: was accepted on create but is missing from the suite list`,
            ).toBeTruthy();
          }
        }
      } finally {
        await cleanup(
          request,
          created.map((id) => `/api/suites/${id}`),
        );
      }
    },
  );

  test(
    ticket("REG-SUITE-03", "10217475765", "opening a suite that does not exist is a clean 404, not a crash"),
    { tag: '@tesbo.testId("TES-TC-1245")' },
    async ({ request }) => {
      // The other half of "clicking a test suite" going wrong: a stale id from a list the user still
      // has open. A malformed uuid is the case that reaches Postgres's cast and 500s if unguarded.
      const projectId = accountA().projectId;

      for (const id of [
        "00000000-0000-0000-0000-000000000000",
        "not-a-uuid",
        "1",
      ]) {
        const rename = await request.patch(`/api/suites/${encodeURIComponent(id)}`, {
          data: { name: unique("Nope") },
          failOnStatusCode: false,
        });
        expect(rename.status(), `PATCH with id "${id}": ${NEVER_5XX}`).toBeLessThan(500);

        const cases = await request.get(`/api/projects/${projectId}/testcases`, {
          params: { suiteId: id },
          failOnStatusCode: false,
        });
        expect(cases.status(), `listing cases for suite "${id}": ${NEVER_5XX}`).toBeLessThan(500);
      }
    },
  );

  test(
    ticket("REG-SUITE-04", "10217475765", "a suite holding a test case still opens"),
    { tag: '@tesbo.testId("TES-TC-1246")' },
    async ({ request }) => {
      /*
       * The state the reporter would most plausibly have been in — a suite with something in it,
       * reached from a screen that shows counts. Worth its own test because the suite list computes
       * testCaseCount with a join, and a join is where a read that worked on an empty suite starts
       * failing on a populated one.
       */
      const projectId = accountA().projectId;
      const suite = await (
        await request.post(`/api/projects/${projectId}/suites`, { data: { name: unique("Suite") } })
      ).json();
      const testcase = await createTestCase(request, projectId, { suiteId: suite.id });

      try {
        const list = await request.get(`/api/projects/${projectId}/suites`);
        expect(list.status(), NEVER_5XX).toBeLessThan(500);
        const found = (await list.json()).find((s: { id: string }) => s.id === suite.id);
        expect(found, "the suite should still be listed once it holds a case").toBeTruthy();
        expect(found.testCaseCount).toBe(1);

        const read = await request.get(`/api/projects/${projectId}/testcases/${testcase.id}`);
        expect(read.status(), NEVER_5XX).toBeLessThan(500);
        expect((await read.json()).suiteId).toBe(suite.id);
      } finally {
        await cleanup(request, [
          `/api/projects/${projectId}/testcases/${testcase.id}`,
          `/api/suites/${suite.id}`,
        ]);
      }
    },
  );
});

/*
 * The same defect, on the three entities beside suites.
 *
 * REG-SUITE-02 above proved the mechanism: suites.name is VARCHAR(255), nothing validated the length,
 * and Postgres's 22001 surfaced as a 500 on an ordinary bad request. Reading the schema afterwards
 * showed the hole was open in four places, not one — cycles.name and plans.name are VARCHAR(255) too,
 * bugs.title is VARCHAR(512), and cycles/plans carry several VARCHAR(128) label columns. None of them
 * had a length check on create or update.
 *
 * That is the pattern docs/basecamp-bugfix-flow.md warns about ("one card reported an unvalidated
 * title; testcases had 14 unvalidated bounded columns, each its own latent 500"), so these tests
 * cover the whole family rather than only the entity the card happened to name.
 *
 * Each field is checked in both directions, and the second direction matters as much as the first:
 *
 *   over the column width  -> a deliberate 4xx, never a 5xx, and nothing persisted
 *   exactly the width      -> ACCEPTED
 *
 * Without the second, a fix that bounded these at some tighter arbitrary number — or refused them
 * outright — would pass. The limit is supposed to be the column's own width.
 */

const BOUNDED = [
  { entity: "suite", field: "name", max: 255, label: "suites.name" },
  { entity: "cycle", field: "name", max: 255, label: "cycles.name" },
  { entity: "cycle", field: "environment", max: 128, label: "cycles.environment" },
  { entity: "cycle", field: "buildVersion", max: 128, label: "cycles.build_version" },
  { entity: "cycle", field: "releaseName", max: 128, label: "cycles.release_name" },
  { entity: "plan", field: "name", max: 255, label: "plans.name" },
  { entity: "plan", field: "targetRelease", max: 128, label: "plans.target_release" },
  { entity: "bug", field: "title", max: 512, label: "bugs.title" },
] as const;

/** Creates one entity of the given kind, returning the response and a teardown path for it. */
async function createEntity(
  api: APIRequestContext,
  projectId: string,
  entity: (typeof BOUNDED)[number]["entity"],
  body: Record<string, unknown>,
) {
  switch (entity) {
    case "suite":
      return {
        res: await api.post(`/api/projects/${projectId}/suites`, { data: body, failOnStatusCode: false }),
        path: (id: string) => `/api/suites/${id}`,
      };
    case "cycle":
      return {
        res: await api.post(`/api/projects/${projectId}/cycles`, { data: body, failOnStatusCode: false }),
        path: (id: string) => `/api/cycles/${id}`,
      };
    case "plan":
      return {
        res: await api.post(`/api/projects/${projectId}/plans`, { data: body, failOnStatusCode: false }),
        path: (id: string) => `/api/plans/${id}`,
      };
    case "bug":
      // links: [] is accepted deliberately — createBug only requires a link when the project has
      // something to link to, so an empty array keeps this test independent of the project's runs.
      return {
        res: await api.post(`/api/projects/${projectId}/bugs`, {
          data: { links: [], ...body },
          failOnStatusCode: false,
        }),
        path: (id: string) => `/api/bugs/${id}`,
      };
  }
}

/** The field this entity cannot be created without, so a test for some OTHER field can get that far. */
function requiredFieldsFor(entity: (typeof BOUNDED)[number]["entity"]): Record<string, unknown> {
  switch (entity) {
    case "suite":
      return { name: unique("Suite") };
    case "cycle":
      return { name: unique("Run") };
    case "plan":
      return { name: unique("Plan") };
    case "bug":
      return { title: unique("Bug") };
  }
}

test.describe("bounded name and title columns — reported ticket 10217475765", () => {
  for (const { entity, field, max, label } of BOUNDED) {
    test(
      ticket("REG-BOUND", "10217475765", `${label}: a value over ${max} characters is refused, not crashed on`),
      async ({ request }) => {
        const projectId = accountA().projectId;
        const created: string[] = [];

        try {
          const overLong = "x".repeat(max + 1);
          const { res, path } = await createEntity(request, projectId, entity, {
            ...requiredFieldsFor(entity),
            [field]: overLong,
          });

          if (res.ok()) created.push(path((await res.json()).id));

          expect(
            res.status(),
            `${label} accepted ${max + 1} characters with a ${res.status()} — the column holds ${max}, ` +
              "so this is either an unhandled 22001 (5xx) or a silent truncation",
          ).toBeLessThan(500);
          expect(
            res.status(),
            `${label} should refuse ${max + 1} characters with a 4xx`,
          ).toBeGreaterThanOrEqual(400);
        } finally {
          await cleanup(request, created);
        }
      },
    );

    test(
      ticket("REG-BOUND", "10217475765", `${label}: a value of exactly ${max} characters is accepted`),
      async ({ request }) => {
        // The guard against over-correcting. A fix that bounded this at 50, or refused the field
        // altogether, would satisfy the test above and break a legitimate value.
        const projectId = accountA().projectId;
        const created: string[] = [];

        try {
          const atLimit = "y".repeat(max);
          const { res, path } = await createEntity(request, projectId, entity, {
            ...requiredFieldsFor(entity),
            [field]: atLimit,
          });

          if (res.ok()) created.push(path((await res.json()).id));

          expect(
            res.status(),
            `${label} refused a value of exactly ${max} characters, which the column can hold: ` +
              (await res.text()),
          ).toBeLessThan(400);
        } finally {
          await cleanup(request, created);
        }
      },
    );
  }
});
