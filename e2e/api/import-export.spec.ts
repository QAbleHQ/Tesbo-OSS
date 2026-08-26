import { expect, test, type APIRequestContext } from "@playwright/test";
import * as XLSX from "xlsx";
import { setGraceWindow, setProPlan } from "../utils/billing-db";
import { parseCsv, parseCsvRecords } from "../utils/csv";
import { emailDomain } from "../utils/env";
import { exec, literal } from "../utils/psql";
import {
  anonymousContext,
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  seedFixtureUser,
  type RbacTenant,
} from "../utils/rbac-tenant";

/*
 * Getting data out of Tesbo and back into it: the test case CSV/XLSX exports, the import template,
 * the (stubbed) server-side import routes, and the run export.
 *
 * Where the import actually happens matters for reading this file: POST testcases/import/preview and
 * POST testcases/import are stubs in legacy.controller.ts that return a fixed empty payload. The real
 * import is client-side — components/ImportTestCasesModal.tsx parses the workbook in the browser and
 * POSTs one createTestCase per row — so the row-level import behaviour is covered in
 * ui/testcase-import.spec.ts, and what's asserted here is only that the dead routes don't hand a
 * caller a fabricated success.
 *
 * Runs against its own disposable workspace ("import-export"): the exports assert on the WHOLE
 * project's contents, so a shared project other specs are seeding into would make the row counts
 * race. The plan-lock case additionally rewrites the workspace's plan, which no shared account can
 * absorb.
 */

/** The documented column set of the test case export — LegacyController.TESTCASE_EXPORT_BASE_HEADERS. */
const EXPORT_HEADERS = [
  "externalId",
  "title",
  "description",
  "preconditions",
  "steps",
  "testData",
  "priority",
  "severity",
  "type",
  "status",
  "suite",
  "component",
];

/** The import template's columns — LegacyController.template()'s example row. */
const TEMPLATE_HEADERS = [
  "title",
  "description",
  "preconditions",
  "steps",
  "testData",
  "priority",
  "severity",
  "type",
  "status",
  "suite",
  "component",
];

const RUN_EXPORT_HEADERS = [
  "externalId",
  "title",
  "status",
  "priority",
  "type",
  "actualResult",
  "executedAt",
  "defectKey",
  "defectUrl",
];

interface SeededCase {
  id: string;
  title: string;
  externalId: string;
}

test.describe("import / export", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let asGuest: APIRequestContext;
  let asOutsider: APIRequestContext;
  let anon: APIRequestContext;

  /** A project of this suite's own, so an export's row count is exactly what a test seeded. */
  let projectId: string;
  const createdCaseIds: string[] = [];
  const createdCycleIds: string[] = [];
  const createdProjectIds: string[] = [];

  const seedCase = async (
    data: Record<string, unknown>,
    project = projectId,
  ): Promise<SeededCase> => {
    const res = await asOwner.post(`/api/projects/${project}/testcases`, { data });
    if (!res.ok()) throw new Error(`Could not seed a test case (${res.status()}): ${await res.text()}`);
    const created = await res.json();
    createdCaseIds.push(created.id);
    return { id: created.id, title: created.title, externalId: created.externalId };
  };

  /*
   * Every content assertion here reads a WHOLE project's export, so each such test gets a project of
   * its own rather than filtering rows out of a shared one.
   *
   * The explicit key is not decoration: projectKey() derives a key from the name, uppercases it,
   * strips non-alphanumerics and truncates to 16 characters, and (organization_id, key) is unique
   * forever — including for archived projects. Names like "E2E Export Contents <stamp>" all collapse
   * to the same key, and the collision surfaces as a 500 (pinned in api/projects.spec.ts). So keys
   * are short and carry the varying part themselves.
   */
  let keyCounter = 0;
  const newProject = async (name: string): Promise<string> => {
    keyCounter += 1;
    const key = `IE${Date.now().toString().slice(-9)}${keyCounter % 10}`;
    const res = await asOwner.post("/api/projects", { data: { name, key } });
    if (!res.ok()) throw new Error(`Could not create ${name} (${res.status()}): ${await res.text()}`);
    const id = (await res.json()).id;
    createdProjectIds.push(id);
    return id;
  };

  const exportCsv = async (api: APIRequestContext, project = projectId) =>
    api.get(`/api/projects/${project}/testcases/export/csv`, { failOnStatusCode: false });

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("import-export");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    asGuest = await loginAs(tenant.guest);
    asOutsider = await loginAs(
      seedFixtureUser(`e2e-import-export-outsider@${emailDomain}`, "E2E Import Export Outsider"),
    );
    anon = await anonymousContext();
    projectId = await newProject(`E2E Export Project ${Date.now()}`);
  });

  test.afterAll(async () => {
    if (tenant) {
      // Back to Pro: the plan-lock test flips this workspace to Launch, and a tenant left on Launch
      // would have its fixture projects refused by the next run's provisioning.
      setProPlan(tenant.organizationId);
      for (const id of createdCycleIds) {
        await asOwner.delete(`/api/cycles/${id}`, { failOnStatusCode: false });
      }
      for (const id of createdCaseIds) {
        await asOwner.delete(`/api/projects/${projectId}/testcases/${id}`, { failOnStatusCode: false });
      }
      // Projects are archived rather than deleted by the API, which is enough: an archived project is
      // outside every list, count and plan limit these suites read.
      for (const id of createdProjectIds) {
        await asOwner.delete(`/api/projects/${id}`, { failOnStatusCode: false });
      }
    }
    await Promise.all([asOwner, asGuest, asOutsider, anon].filter(Boolean).map((ctx) => ctx.dispose()));
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  /* ───────────────────────── test case CSV export ───────────────────────── */

  test("exports every live test case under the documented header row", { tag: '@tesbo.testId("TES-TC-197")' }, async () => {
    const stamp = Date.now();
    const project = await newProject(`E2E Export Contents ${stamp}`);
    const suite = await (
      await asOwner.post(`/api/projects/${project}/suites`, { data: { name: `E2E Export Suite ${stamp}` } })
    ).json();

    const kept = await seedCase(
      {
        title: `E2E Export Kept ${stamp}`,
        description: "Exported description",
        preconditions: "Signed in",
        testData: "user@example.com",
        priority: "P1",
        severity: "High",
        type: "Regression",
        status: "Approved",
        component: "Billing",
      },
      project,
    );
    const inSuite = await seedCase(
      { title: `E2E Export In Suite ${stamp}`, suiteId: suite.id },
      project,
    );
    const removed = await seedCase({ title: `E2E Export Removed ${stamp}` }, project);
    await asOwner.delete(`/api/projects/${project}/testcases/${removed.id}`);

    const res = await exportCsv(asOwner, project);
    expect(res.status()).toBe(200);
    const { headers, records } = parseCsvRecords(await res.text());

    expect(headers, "the CSV header row is the documented column set, in order").toEqual(EXPORT_HEADERS);
    expect(records.map((r) => r.title).sort()).toEqual([kept.title, inSuite.title].sort());

    const keptRow = records.find((r) => r.title === kept.title)!;
    expect(keptRow).toMatchObject({
      externalId: kept.externalId,
      description: "Exported description",
      preconditions: "Signed in",
      testData: "user@example.com",
      priority: "P1",
      severity: "High",
      type: "Regression",
      status: "Approved",
      component: "Billing",
      suite: "",
    });
    // The suite column is the joined suite NAME, not its id — that's what makes an export
    // re-importable, since the import maps "Suite" by name.
    expect(records.find((r) => r.title === inSuite.title)!.suite).toBe(suite.name);
  });

  test("serialises each step as \"action => expected result\", joined by \" | \"", { tag: '@tesbo.testId("TES-TC-198")' }, async () => {
    const stamp = Date.now();
    const project = await newProject(`E2E Export Steps ${stamp}`);
    const seeded = await seedCase(
      {
        title: `E2E Export Steps ${stamp}`,
        steps: [
          { stepNumber: 1, action: "Open the login page", expectedResult: "The form is shown" },
          // No expected result: the separator must not be emitted for an absent half, or a
          // re-import would read a trailing "=>" as an empty expected result.
          { stepNumber: 2, action: "Submit empty credentials" },
        ],
      },
      project,
    );

    const { records } = parseCsvRecords(await (await exportCsv(asOwner, project)).text());
    expect(records.find((r) => r.title === seeded.title)!.steps).toBe(
      "Open the login page => The form is shown | Submit empty credentials",
    );
  });

  test("quotes values containing commas, quotes and newlines so they survive the round trip", { tag: '@tesbo.testId("TES-TC-199")' }, async () => {
    const stamp = Date.now();
    const project = await newProject(`E2E Export Quoting ${stamp}`);
    const title = `E2E Export "quoted", comma ${stamp}`;
    const description = `line one\nline two, with a comma and a "quote"`;
    await seedCase({ title, description }, project);

    const body = await (await exportCsv(asOwner, project)).text();
    const { records } = parseCsvRecords(body);
    const row = records.find((r) => r.title === title);
    expect(row, "a title containing a comma must not be split across columns").toBeTruthy();
    expect(row!.description).toBe(description);
    // The raw body must actually be quoted, not merely parse back by luck.
    expect(body).toContain('"E2E Export ""quoted"", comma');
  });

  test("orders rows by most recently updated", { tag: '@tesbo.testId("TES-TC-200")' }, async () => {
    const stamp = Date.now();
    const project = await newProject(`E2E Export Order ${stamp}`);
    const first = await seedCase({ title: `E2E Export Order A ${stamp}` }, project);
    const second = await seedCase({ title: `E2E Export Order B ${stamp}` }, project);
    await asOwner.put(`/api/projects/${project}/testcases/${first.id}`, {
      data: { description: "touched last" },
    });

    const { records } = parseCsvRecords(await (await exportCsv(asOwner, project)).text());
    expect(records.map((r) => r.title)).toEqual([first.title, second.title]);
  });

  test("a project with no test cases exports the header row and nothing else", { tag: '@tesbo.testId("TES-TC-201")' }, async () => {
    const project = await newProject(`E2E Export Empty ${Date.now()}`);
    const res = await exportCsv(asOwner, project);
    expect(res.status()).toBe(200);
    const rows = parseCsv(await res.text());
    expect(rows).toEqual([EXPORT_HEADERS]);
  });

  test("sends the CSV as a named attachment", { tag: '@tesbo.testId("TES-TC-202")' }, async () => {
    const res = await exportCsv(asOwner);
    expect(res.headers()["content-type"]).toContain("text/csv");
    expect(res.headers()["content-disposition"]).toBe('attachment; filename="testcases.csv"');
  });

  test("adds a cf_<key> column for each active custom field, and drops archived ones", { tag: '@tesbo.testId("TES-TC-203")' }, async () => {
    const stamp = Date.now();
    const project = await newProject(`E2E Export Custom Fields ${stamp}`);
    const text = await (
      await asOwner.post(`/api/projects/${project}/custom-fields/definitions`, {
        data: { name: `Owner Team ${stamp}`, fieldType: "text" },
      })
    ).json();
    const select = await (
      await asOwner.post(`/api/projects/${project}/custom-fields/definitions`, {
        data: {
          name: `Release ${stamp}`,
          fieldType: "single_select",
          config: { options: [{ label: "R1" }, { label: "R2" }] },
        },
      })
    ).json();
    const retired = await (
      await asOwner.post(`/api/projects/${project}/custom-fields/definitions`, {
        data: { name: `Retired ${stamp}`, fieldType: "text" },
      })
    ).json();
    await asOwner.patch(
      `/api/projects/${project}/custom-fields/definitions/${retired.id}/status`,
      { data: { status: "archived" } },
    );

    const r2 = select.config.options.find((o: { label: string }) => o.label === "R2");
    const seeded = await seedCase(
      {
        title: `E2E Export Custom Field Values ${stamp}`,
        customFieldValues: { [text.id]: "Platform", [select.id]: r2.id },
      },
      project,
    );

    const { headers, records } = parseCsvRecords(await (await exportCsv(asOwner, project)).text());
    expect(headers.slice(0, EXPORT_HEADERS.length)).toEqual(EXPORT_HEADERS);
    expect(headers).toContain(`cf_${text.key}`);
    expect(headers).toContain(`cf_${select.key}`);
    expect(headers, "an archived definition is not a column").not.toContain(`cf_${retired.key}`);

    const row = records.find((r) => r.title === seeded.title)!;
    expect(row[`cf_${text.key}`]).toBe("Platform");
    // A select exports its option LABEL, not the option id a raw value column would carry.
    expect(row[`cf_${select.key}`]).toBe("R2");
  });

  /* ───────────────────────── test case XLSX export ───────────────────────── */

  test("exports a workbook whose \"Test Cases\" sheet matches the CSV", { tag: '@tesbo.testId("TES-TC-204")' }, async () => {
    const stamp = Date.now();
    const project = await newProject(`E2E Export Workbook ${stamp}`);
    const seeded = await seedCase(
      {
        title: `E2E Export Workbook Case ${stamp}`,
        description: "In the workbook",
        priority: "P3",
        steps: [{ stepNumber: 1, action: "Click", expectedResult: "It clicks" }],
      },
      project,
    );

    const res = await asOwner.get(`/api/projects/${project}/testcases/export/xlsx`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("spreadsheetml.sheet");
    expect(res.headers()["content-disposition"]).toBe('attachment; filename="testcases.xlsx"');

    const workbook = XLSX.read(await res.body(), { type: "buffer" });
    expect(workbook.SheetNames).toContain("Test Cases");
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets["Test Cases"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalId: seeded.externalId,
      title: seeded.title,
      description: "In the workbook",
      priority: "P3",
      steps: "Click => It clicks",
    });
  });

  test("a project with no test cases still exports a workbook carrying the header row", { tag: '@tesbo.testId("TES-TC-205")' }, async () => {
    // Red: sendWorkbook builds the sheet with XLSX.utils.json_to_sheet(rows), which derives its
    // header from the first row's keys — so with no rows there is no header either, and the
    // downloaded file opens as a completely blank sheet with no columns to fill in. The CSV export
    // of the same empty project does emit its header row (asserted above), so this is an
    // inconsistency between the two formats, not the intended contract.
    const project = await newProject(`E2E Export Empty Workbook ${Date.now()}`);
    const res = await asOwner.get(`/api/projects/${project}/testcases/export/xlsx`);
    expect(res.status()).toBe(200);

    const workbook = XLSX.read(await res.body(), { type: "buffer" });
    const sheet = workbook.Sheets["Test Cases"];
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, blankrows: false });
    expect(rows[0], "the empty workbook has no header row at all").toEqual(EXPORT_HEADERS);
  });

  /* ───────────────────────── export authorization ───────────────────────── */

  for (const format of ["csv", "xlsx"] as const) {
    test(`the ${format} export refuses callers without access to the project`, async () => {
      const path = `/api/projects/${projectId}/testcases/export/${format}`;

      const anonRes = await anon.get(path, { failOnStatusCode: false });
      // requireUser raises 400 ("Authentication required") rather than 401 — see rbac.spec.ts.
      expect([400, 401], "an anonymous caller must not be handed an export").toContain(anonRes.status());

      const guestRes = await asGuest.get(path, { failOnStatusCode: false });
      expect(guestRes.status(), "a workspace member with no project access is refused").toBe(404);

      const outsiderRes = await asOutsider.get(path, { failOnStatusCode: false });
      expect(outsiderRes.status(), "a caller from outside the workspace is refused").toBe(404);
    });

    test(`the ${format} export answers a malformed project id with 404, not 500`, async () => {
      const res = await asOwner.get(`/api/projects/not-a-uuid/testcases/export/${format}`, {
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(404);
    });
  }

  /* ───────────────────────── import template ───────────────────────── */

  test("the CSV template documents every importable column with a worked example", { tag: '@tesbo.testId("TES-TC-210")' }, async () => {
    const res = await asOwner.get(`/api/projects/${projectId}/testcases/import/template`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
    expect(res.headers()["content-disposition"]).toBe(
      'attachment; filename="testcase-import-template.csv"',
    );

    const { headers, records } = parseCsvRecords(await res.text());
    expect(headers).toEqual(TEMPLATE_HEADERS);
    expect(records).toHaveLength(1);
    // The example must teach the two conventions the importer relies on, or a user filling the
    // template in cannot produce steps with expected results at all: " | " between steps, " => "
    // between an action and its expected result.
    expect(records[0].steps).toContain(" => ");
    expect(records[0].steps).toContain(" | ");
    expect(records[0].title).toBeTruthy();
  });

  test("format=xlsx returns the same template as a workbook", { tag: '@tesbo.testId("TES-TC-211")' }, async () => {
    const res = await asOwner.get(
      `/api/projects/${projectId}/testcases/import/template?format=xlsx`,
    );
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("spreadsheetml.sheet");
    expect(res.headers()["content-disposition"]).toBe(
      'attachment; filename="testcase-import-template.xlsx"',
    );

    const workbook = XLSX.read(await res.body(), { type: "buffer" });
    expect(workbook.SheetNames).toContain("Test Cases");
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets["Test Cases"]);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0])).toEqual(TEMPLATE_HEADERS);
  });

  test("an unrecognised format falls back to the CSV template", { tag: '@tesbo.testId("TES-TC-212")' }, async () => {
    const res = await asOwner.get(
      `/api/projects/${projectId}/testcases/import/template?format=json`,
    );
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
    expect(parseCsv(await res.text())[0]).toEqual(TEMPLATE_HEADERS);
  });

  test("the template is project-scoped and needs a session", { tag: '@tesbo.testId("TES-TC-213")' }, async () => {
    // Red: template() takes neither @Req() nor a look at the project id, so it serves the same file
    // to an anonymous caller and to a request naming a project that doesn't exist. Nothing tenant-
    // specific leaks — the payload is a constant — but it is the only route under
    // /api/projects/:id/ that answers with no session, and the frontend links to it from a
    // signed-in screen only. Either it should authorize like its siblings or it should not be
    // project-scoped.
    const anonRes = await anon.get(`/api/projects/${projectId}/testcases/import/template`, {
      failOnStatusCode: false,
    });
    expect([400, 401], "the template must not be served without a session").toContain(
      anonRes.status(),
    );

    const unknownRes = await asOwner.get(
      "/api/projects/00000000-0000-0000-0000-000000000000/testcases/import/template",
      { failOnStatusCode: false },
    );
    expect(unknownRes.status(), "a project that doesn't exist has no template").toBe(404);
  });

  /* ───────────────────────── the server-side import routes ───────────────────────── */

  test("the import routes refuse an anonymous caller", { tag: '@tesbo.testId("TES-TC-214")' }, async () => {
    // Red: previewImport()/executeImport() take no @Req() and no @Body() — they return a fixed
    // payload to anyone. Harmless today only because they do nothing at all.
    for (const path of [
      `/api/projects/${projectId}/testcases/import/preview`,
      `/api/projects/${projectId}/testcases/import`,
    ]) {
      const res = await anon.post(path, { data: {}, failOnStatusCode: false });
      expect([400, 401, 404], `${path} must not answer an anonymous caller with a success`).toContain(
        res.status(),
      );
    }
  });

  test("the import routes do not report a success they didn't perform", { tag: '@tesbo.testId("TES-TC-215")' }, async () => {
    // Red: both routes are stubs. preview returns {uploadId:"local-upload", totalRows:0} for any
    // file, and import returns {imported:0} without reading its body — so a client that trusts
    // either one silently imports nothing and is told everything went fine.
    //
    // The real import lives in the browser (ImportTestCasesModal calls createTestCase per row), so
    // the fix is either to implement these server-side or to delete them along with the dead
    // previewImport/executeImport helpers in Tesbo-Frontend/lib/api.ts. This asserts the property
    // that holds under either fix: a 2xx here must mean rows were actually imported.
    const before = await (await asOwner.get(`/api/projects/${projectId}/testcases`)).json();
    const countBefore = Array.isArray(before) ? before.length : before.total;

    const res = await asOwner.post(`/api/projects/${projectId}/testcases/import`, {
      data: { uploadId: "local-upload", columnMapping: { title: 0 } },
      failOnStatusCode: false,
    });

    if (res.status() < 300) {
      const body = await res.json();
      const after = await (await asOwner.get(`/api/projects/${projectId}/testcases`)).json();
      const countAfter = Array.isArray(after) ? after.length : after.total;
      expect(countAfter - countBefore, "the reported count must match what landed").toBe(body.imported);
      expect(body.imported, "the stub reports 0 imported for every request").toBeGreaterThan(0);
    } else {
      expect([400, 404, 501]).toContain(res.status());
    }
  });

  /* ───────────────────────── run (cycle) CSV export ───────────────────────── */

  const seedRun = async (name: string, project = projectId) => {
    const cycle = await (
      await asOwner.post(`/api/projects/${project}/cycles`, { data: { name } })
    ).json();
    createdCycleIds.push(cycle.id);
    return cycle.id as string;
  };

  const executionsOf = async (cycleId: string) =>
    (await (await asOwner.get(`/api/cycles/${cycleId}/executions`)).json()) as {
      id: string;
      testcaseId: string;
    }[];

  test("exports one row per execution with the result that was recorded", { tag: '@tesbo.testId("TES-TC-216")' }, async () => {
    const stamp = Date.now();
    const project = await newProject(`E2E Run Export ${stamp}`);
    const passed = await seedCase({ title: `E2E Run Export Passed ${stamp}`, priority: "P1", type: "Smoke" }, project);
    const failed = await seedCase({ title: `E2E Run Export Failed ${stamp}` }, project);
    const cycleId = await seedRun(`E2E Run Export ${stamp}`, project);
    await asOwner.post(`/api/cycles/${cycleId}/testcases`, {
      data: { testcaseIds: [passed.id, failed.id] },
    });

    const executions = await executionsOf(cycleId);
    const passedExecution = executions.find((e) => e.testcaseId === passed.id)!;
    const failedExecution = executions.find((e) => e.testcaseId === failed.id)!;
    await asOwner.patch(`/api/cycles/${cycleId}/executions/${passedExecution.id}`, {
      data: { status: "Passed", actualResult: "As expected" },
    });
    await asOwner.patch(`/api/cycles/${cycleId}/executions/${failedExecution.id}`, {
      data: {
        status: "Failed",
        actualResult: "Threw a 500",
        defectKey: "BUG-1",
        defectUrl: "https://tracker.invalid/BUG-1",
      },
    });

    const res = await asOwner.get(`/api/cycles/${cycleId}/export/csv`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
    expect(res.headers()["content-disposition"]).toBe('attachment; filename="test-run.csv"');

    const { headers, records } = parseCsvRecords(await res.text());
    expect(headers).toEqual(RUN_EXPORT_HEADERS);
    // Rows come out in cycle_items order (position, then created_at) — the order the cases were added.
    expect(records.map((r) => r.title)).toEqual([passed.title, failed.title]);
    expect(records[0]).toMatchObject({
      externalId: passed.externalId,
      status: "Passed",
      priority: "P1",
      type: "Smoke",
      actualResult: "As expected",
      defectKey: "",
      defectUrl: "",
    });
    expect(records[0].executedAt, "a recorded result carries its timestamp").not.toBe("");
    expect(records[1]).toMatchObject({
      status: "Failed",
      actualResult: "Threw a 500",
      defectKey: "BUG-1",
      defectUrl: "https://tracker.invalid/BUG-1",
    });
  });

  test("keeps the snapshot title of a case that was deleted after the run was built", { tag: '@tesbo.testId("TES-TC-217")' }, async () => {
    const stamp = Date.now();
    const project = await newProject(`E2E Run Export Snapshot ${stamp}`);
    const seeded = await seedCase({ title: `E2E Run Export Snapshot Case ${stamp}` }, project);
    const cycleId = await seedRun(`E2E Run Export Snapshot ${stamp}`, project);
    await asOwner.post(`/api/cycles/${cycleId}/testcases`, { data: { testcaseIds: [seeded.id] } });
    await asOwner.delete(`/api/projects/${project}/testcases/${seeded.id}`);

    const { records } = parseCsvRecords(await (await asOwner.get(`/api/cycles/${cycleId}/export/csv`)).text());
    expect(records).toHaveLength(1);
    // The run keeps reporting what was run, even though the case is gone from the project.
    expect(records[0].title).toBe(seeded.title);
    expect(records[0].externalId, "the case's own columns are empty once it's deleted").toBe("");
  });

  test("excludes soft-deleted executions", { tag: '@tesbo.testId("TES-TC-218")' }, async () => {
    const stamp = Date.now();
    const project = await newProject(`E2E Run Export Deleted ${stamp}`);
    const kept = await seedCase({ title: `E2E Run Export Kept ${stamp}` }, project);
    const dropped = await seedCase({ title: `E2E Run Export Dropped ${stamp}` }, project);
    const cycleId = await seedRun(`E2E Run Export Deleted ${stamp}`, project);
    await asOwner.post(`/api/cycles/${cycleId}/testcases`, {
      data: { testcaseIds: [kept.id, dropped.id] },
    });

    const executions = await executionsOf(cycleId);
    const droppedExecution = executions.find((e) => e.testcaseId === dropped.id)!;
    // There is no DELETE route for an execution — the product only ever soft-deletes them from
    // cycle edits, so the fixture writes the column the export's WHERE clause reads.
    exec(`UPDATE executions SET deleted_at = now() WHERE id = ${literal(droppedExecution.id)};`);

    const { records } = parseCsvRecords(await (await asOwner.get(`/api/cycles/${cycleId}/export/csv`)).text());
    expect(records.map((r) => r.title)).toEqual([kept.title]);
  });

  test("a run with no cases exports the header row and nothing else", { tag: '@tesbo.testId("TES-TC-219")' }, async () => {
    const cycleId = await seedRun(`E2E Run Export Empty ${Date.now()}`);
    const res = await asOwner.get(`/api/cycles/${cycleId}/export/csv`);
    expect(res.status()).toBe(200);
    expect(parseCsv(await res.text())).toEqual([RUN_EXPORT_HEADERS]);
  });

  test("the run export refuses callers without access to the run", { tag: '@tesbo.testId("TES-TC-220")' }, async () => {
    // Red: exportCycle() takes no @Req() at all, so the whole run — case titles, external ids,
    // actual results, and the linked defect keys and URLs — is readable by anyone holding a cycle
    // id, with no session and from any workspace. This is the same "the controller method never
    // takes @Req()" pattern as the attachment reads.
    const stamp = Date.now();
    const seeded = await seedCase({ title: `E2E Run Export Authz ${stamp}` });
    const cycleId = await seedRun(`E2E Run Export Authz ${stamp}`);
    await asOwner.post(`/api/cycles/${cycleId}/testcases`, { data: { testcaseIds: [seeded.id] } });
    const path = `/api/cycles/${cycleId}/export/csv`;

    const anonRes = await anon.get(path, { failOnStatusCode: false });
    expect([400, 401], "an anonymous caller must not be able to export a run").toContain(
      anonRes.status(),
    );
    // Belt and braces: if it does answer, prove the leak rather than only the status code.
    if (anonRes.status() === 200) {
      expect(await anonRes.text(), "…and the body is the real run").not.toContain(seeded.title);
    }

    const guestRes = await asGuest.get(path, { failOnStatusCode: false });
    expect([403, 404], "a workspace member with no project access is refused").toContain(
      guestRes.status(),
    );

    const outsiderRes = await asOutsider.get(path, { failOnStatusCode: false });
    expect([403, 404], "a caller from another workspace is refused").toContain(outsiderRes.status());
  });

  test("answers an unresolvable run id with 404", { tag: '@tesbo.testId("TES-TC-221")' }, async () => {
    // Red on both counts: a malformed id reaches Postgres as a uuid cast and 500s, and a
    // well-formed id for a run that doesn't exist returns 200 with a header-only CSV — so a typo
    // in a run id downloads an empty "report" instead of saying the run isn't there.
    const malformed = await asOwner.get("/api/cycles/not-a-uuid/export/csv", {
      failOnStatusCode: false,
    });
    expect(malformed.status(), "a malformed run id must not 500").toBe(404);

    const unknown = await asOwner.get(
      "/api/cycles/00000000-0000-0000-0000-000000000000/export/csv",
      { failOnStatusCode: false },
    );
    expect(unknown.status(), "a run that doesn't exist is a 404, not an empty CSV").toBe(404);
  });

  /* ───────────────────────── plan gating ───────────────────────── */

  test("a read-only locked project can still be exported, but not imported into", { tag: '@tesbo.testId("TES-TC-222")' }, async () => {
    // ProjectWriteLockGuard is documented as deliberately narrow: "locked projects stay fully
    // READABLE. Customers can always see and export their data." Both halves of that promise are
    // load-bearing for a workspace trying to get its data out after a downgrade, so both are
    // asserted here — the export must keep working, and the write the importer performs must not.
    const stamp = Date.now();
    const locked = await newProject(`E2E Export Locked ${stamp}`);
    const seeded = await seedCase({ title: `E2E Export Locked Case ${stamp}` }, locked);

    try {
      // The oldest 2 active projects stay writable on Launch; this workspace's fixture projects are
      // older, so the project created just above is the one that locks.
      setGraceWindow(tenant!.organizationId, -1);

      const exportRes = await exportCsv(asOwner, locked);
      expect(exportRes.status(), "a locked project must stay exportable").toBe(200);
      const { records } = parseCsvRecords(await exportRes.text());
      expect(records.map((r) => r.title)).toContain(seeded.title);

      const workbookRes = await asOwner.get(`/api/projects/${locked}/testcases/export/xlsx`, {
        failOnStatusCode: false,
      });
      expect(workbookRes.status(), "…in both formats").toBe(200);

      // What the import wizard actually does, row by row.
      const importRes = await asOwner.post(`/api/projects/${locked}/testcases`, {
        data: { title: `E2E Export Locked Import ${stamp}` },
        failOnStatusCode: false,
      });
      expect(importRes.status(), "importing into a locked project is refused").toBe(403);
      expect((await importRes.json()).error).toContain("read-only");
    } finally {
      setProPlan(tenant!.organizationId);
    }
  });
});
