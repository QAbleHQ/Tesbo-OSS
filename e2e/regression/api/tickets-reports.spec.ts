import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  accountA,
  anonymousApiContext,
  apiContext,
  apiContextB,
  cleanupRun,
  createTestCase,
  seedRun,
  ticket,
  unique,
  type SeededRun,
} from "../fixtures";

/*
 * Reported-ticket regression for the reports export endpoint.
 * Card 10218723531 — "Reports & Insights > Export buttons are not working".
 *
 * The button was never wired to anything (no onClick, title="Coming soon"), so this endpoint is NEW
 * rather than fixed — the card is an unbuilt feature that was read as a defect, and the fix was to
 * build it. Six views, two formats.
 *
 * WHY IT IS COVERED AGAIN HERE. api/reports.spec.ts covers the same endpoint far more thoroughly,
 * but that file builds a whole disposable project through utils/seed.ts and utils/rbac-tenant.ts,
 * writes execution timestamps directly into Postgres, and puts its tenant on Pro through
 * utils/billing-db.ts. On a deployed environment none of that is available: rbacSuiteSkipReason is
 * non-null and the entire file skips. So on stage — the environment the button was reported broken
 * on — there was no cover for this card at all.
 *
 * WHAT THIS VERSION CAN AND CANNOT ASSERT. It runs in account A's shared project, so it cannot make
 * the row-for-row comparisons the seeded fixture allows ("18 passed", "6 test cases"). It asserts
 * the contract that does not depend on the numbers: every view answers, in both formats, with the
 * right content type, the right filename and a parseable shape; the export follows the tab's filter;
 * awkward text survives the CSV quoting; and the bad-input and cross-tenant paths are refused.
 */

const EXPORT_VIEWS = ["overview", "execution", "matrix", "repository", "insights", "trends"] as const;

/** CSV split into rows, respecting the quoting rowsToCsv applies. */
function csvRows(body: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  row.push(cell);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

test.describe("reports export — reported ticket 10218723531", () => {
  let api: APIRequestContext;
  let projectId: string;

  function exportUrl(view: string, format: "csv" | "xlsx", extra = ""): string {
    return `/api/projects/${projectId}/reports/export/${format}?view=${view}${extra}`;
  }

  test.beforeAll(async () => {
    api = await apiContext();
    projectId = accountA().projectId;
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  for (const view of EXPORT_VIEWS) {
    test(
      ticket("REG-RPT-A-01", "10218723531", `the ${view} view exports a CSV named after itself`),
      async () => {
        const res = await api.get(exportUrl(view, "csv"), { failOnStatusCode: false });
        expect(res.status(), await res.text()).toBe(200);
        expect(res.headers()["content-type"]).toContain("text/csv");
        // The filename matters: six views downloading as one name is how you end up with
        // report(3).csv and no idea which tab it came from.
        expect(res.headers()["content-disposition"]).toContain(`filename="report-${view}.csv"`);

        const rows = csvRows(await res.text());
        expect(rows.length, "an export with no header row is an empty file with extra steps").toBeGreaterThan(0);
        const header = rows[0];
        if (view === "execution") {
          expect(header).toEqual(["groupName", "Passed", "Failed", "Blocked", "Skipped", "Untested", "Retest", "total"]);
        } else if (view === "matrix") {
          expect(header[0]).toBe("externalId");
          expect(header).toContain("bugUrl");
        } else {
          // The four dashboard views share the long form — one parseable table instead of stacked
          // mini-tables with conflicting headers.
          expect(header).toEqual(["section", "label", "metric", "value"]);
        }
        // Every data row has to have the same width as the header, or nothing can parse it.
        for (const row of rows.slice(1)) expect(row.length).toBe(header.length);
      },
    );
  }

  for (const view of EXPORT_VIEWS) {
    test(ticket("REG-RPT-A-02", "10218723531", `the ${view} view exports a workbook`), async () => {
      const res = await api.get(exportUrl(view, "xlsx"), { failOnStatusCode: false });
      expect(res.status(), await res.text()).toBe(200);
      expect(res.headers()["content-disposition"]).toContain(`filename="report-${view}.xlsx"`);
      const body = Buffer.from(await res.body());
      // xlsx is a zip: "PK" or it is not a workbook, whatever the headers claim.
      expect(body.subarray(0, 2).toString("latin1")).toBe("PK");
      expect(body.length).toBeGreaterThan(0);
    });
  }

  test(
    ticket("REG-RPT-A-03", "10218723531", "the export carries the tab's filter, not the whole project"),
    async () => {
      /*
       * The screen filters by plan/run/suite/person/priority/tag. Exporting while looking at one run
       * and getting every run back would be a quietly wrong file — worse than no export at all.
       *
       * Narrowed to a run this test creates, so "the filter narrowed something" holds regardless of
       * what else the shared project contains: filtering to one fixture run must produce strictly
       * fewer rows than the unfiltered export of a project that also holds everything else.
       */
      let run: SeededRun | undefined;
      try {
        run = await seedRun(api, projectId, {
          statuses: ["Passed", "Failed"],
          status: "Completed",
          name: unique("Export Filter Run"),
        });

        const filter = `&filterBy=run&filterValue=${run.cycleId}`;
        const filtered = csvRows(await (await api.get(exportUrl("execution", "csv", filter))).text());
        const unfiltered = csvRows(await (await api.get(exportUrl("execution", "csv"))).text());

        expect(filtered.length, "a filtered export still needs its header").toBeGreaterThan(0);
        expect(
          filtered.length,
          "filtering to one run returned as many rows as the whole project — the filter is not reaching the export",
        ).toBeLessThan(unfiltered.length);
      } finally {
        await cleanupRun(api, projectId, run);
      }
    },
  );

  test(
    ticket("REG-RPT-A-04", "10218723531", "a title carrying commas, quotes and newlines survives the CSV"),
    async () => {
      // rowsToCsv quotes and doubles quotes; the risk is a cell that silently becomes two columns and
      // shifts every field after it on that row — a file that opens without complaint and is wrong.
      const nasty = `${unique("Export")} "quoted", comma\nand newline`;
      const testcase = await createTestCase(api, projectId, { title: nasty, priority: "P3" });
      try {
        const rows = csvRows(await (await api.get(exportUrl("matrix", "csv"))).text());
        const header = rows[0];
        const titleIndex = header.indexOf("testcaseTitle");
        expect(titleIndex, "the traceability export has no testcaseTitle column").toBeGreaterThanOrEqual(0);

        const match = rows.slice(1).find((row) => row[titleIndex]?.includes("and newline"));
        expect(match, "the awkward title never made it into the export").toBeTruthy();
        expect(match![titleIndex]).toBe(nasty);
        expect(match!.length, "a quoted cell must not widen its row").toBe(header.length);
      } finally {
        await api.delete(`/api/projects/${projectId}/testcases/${testcase.id}`, { failOnStatusCode: false });
      }
    },
  );

  test(
    ticket("REG-RPT-A-05", "10218723531", "an unknown view is refused, naming the ones that exist"),
    async () => {
      const res = await api.get(exportUrl("everything", "csv"), { failOnStatusCode: false });
      expect(res.status()).toBe(400);
      const { error } = await res.json();
      expect(error).toContain("everything");
      for (const view of EXPORT_VIEWS) expect(error).toContain(view);
    },
  );

  test(ticket("REG-RPT-A-06", "10218723531", "an unsupported format is refused"), async () => {
    for (const format of ["pdf", "json", "csv.exe"]) {
      const res = await api.get(`/api/projects/${projectId}/reports/export/${format}?view=overview`, {
        failOnStatusCode: false,
      });
      expect(res.status(), `${format} should be refused, not guessed at`).toBe(400);
    }
  });

  test(
    ticket("REG-RPT-A-07", "10218723531", "no view at all falls back to the overview rather than failing"),
    async () => {
      const res = await api.get(`/api/projects/${projectId}/reports/export/csv`, { failOnStatusCode: false });
      expect(res.status()).toBe(200);
      expect(res.headers()["content-disposition"]).toContain('filename="report-overview.csv"');
    },
  );

  test(
    ticket("REG-RPT-A-08", "10218723531", "the export is not reachable without a session, or from another tenant"),
    async () => {
      /*
       * A new endpoint that serves a whole project's data as a file is exactly the shape of thing
       * that ships without a guard. Both halves are checked: no session at all, and a real session
       * belonging to a different workspace.
       */
      const anon = await anonymousApiContext();
      const other = await apiContextB();
      try {
        const anonRes = await anon.get(`/api/projects/${projectId}/reports/export/csv?view=overview`, {
          failOnStatusCode: false,
        });
        expect([401, 403], `an unauthenticated export returned ${anonRes.status()}`).toContain(anonRes.status());

        const otherRes = await other.get(`/api/projects/${projectId}/reports/export/csv?view=overview`, {
          failOnStatusCode: false,
        });
        expect(
          [403, 404],
          `account B reached account A's export with ${otherRes.status()} — that is a cross-tenant leak`,
        ).toContain(otherRes.status());
      } finally {
        await anon.dispose();
        await other.dispose();
      }
    },
  );
});
