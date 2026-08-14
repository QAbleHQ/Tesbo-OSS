import type { APIRequestContext } from "@playwright/test";
import {
  addRunCases,
  listRunExecutions,
  seedBug,
  seedPlan,
  // Used by the run-seeding loop below. It was missing from this list, which typechecks as an
  // error but only *fails* on a database where the fixture doesn't already exist — the reason the
  // reports suite stayed green on the persistent volume while being broken for a fresh one.
  seedRun,
  seedSuite,
  seedTestCase,
  setExecutionResults,
  type SeededCase,
  type SeededRun,
} from "./seed";

/*
 * The project history the Wave 6 reporting suites assert against — shared by api/reports.spec.ts and
 * ui/reports.spec.ts so both are describing the same numbers, and the screen assertions can be
 * compared against the API assertions rather than against a second, subtly different fixture.
 *
 * It is built so that every branch of the reporting code is reachable and every expected number is
 * arithmetic rather than a guess:
 *
 *   suites      Alpha (4 cases), Beta (1 case), plus one case with no suite at all
 *   cases       flaky P2 [smoke,regression], stable P1 [smoke], lowFlake P2 (untagged),
 *               untestedP1 P1 (never run — feeds the untested-P1 counter), noSuite P3 [api],
 *               old P2 (created 40 days ago — outside the 30-day additions window)
 *   runs        11, two days apart, oldest 22 days ago — straddles the overview's 10-run cap and
 *               trends' 12-run cap, so the two endpoints must disagree about the trend delta
 *   results     flaky alternates Passed/Failed across all 11 runs -> 10 flips, flakiness "High"
 *               stable passes in runs 1-6                         -> not flaky (one status)
 *               lowFlake passes five times then fails once        -> 1 flip in 6, flakiness "Low"
 *               old is added to run 1 and left Untested           -> the Untested branch
 *   coverage    Alpha 3/4 = 75% (healthy), Beta 0/1 = 0% (the one gap), Unassigned 1/1 = 100%
 *   bugs        one yesterday, one 15 days back, one 80 days back (outside the 7-week series)
 */

export const RUN_AGES_IN_DAYS = [22, 20, 18, 16, 14, 12, 10, 8, 6, 4, 2];

export interface ReportsFixture {
  projectId: string;
  alphaSuiteId: string;
  betaSuiteId: string;
  planId: string;
  planName: string;
  cases: {
    flaky: SeededCase;
    stable: SeededCase;
    lowFlake: SeededCase;
    untestedP1: SeededCase;
    noSuite: SeededCase;
    old: SeededCase;
  };
  runs: SeededRun[];
  /** run name -> how many cases the fixture put in it, for cross-checking the report's totals. */
  expectedRunTotals: Map<string, number>;
  bugTitles: { yesterday: string; twoWeeksAgo: string; longAgo: string };
}

/**
 * Seeds the history above into an existing (ideally brand-new) project.
 *
 * `assigneeId` is the user the one assigned case is booked to, so grouping by person has a named
 * bucket next to "Unassigned" instead of one bucket holding everything.
 */
export async function buildReportsFixture(
  api: APIRequestContext,
  projectId: string,
  opts: { assigneeId: string },
): Promise<ReportsFixture> {
  const alphaSuiteId = await seedSuite(api, projectId, "Alpha");
  const betaSuiteId = await seedSuite(api, projectId, "Beta");
  const planName = "E2E Reports Regression Plan";
  const planId = await seedPlan(api, projectId, planName);

  const cases = {
    flaky: await seedTestCase(api, projectId, {
      title: "Checkout flickers between runs",
      suiteId: alphaSuiteId,
      priority: "P2",
      status: "Approved",
      automationTags: "smoke,regression",
    }),
    stable: await seedTestCase(api, projectId, {
      title: "Login always works",
      suiteId: alphaSuiteId,
      priority: "P1",
      status: "Approved",
      automationTags: "smoke",
    }),
    lowFlake: await seedTestCase(api, projectId, {
      title: "Search fails once in six runs",
      suiteId: alphaSuiteId,
      priority: "P2",
      status: "Draft",
    }),
    untestedP1: await seedTestCase(api, projectId, {
      title: "Payment refund has never been run",
      suiteId: betaSuiteId,
      priority: "P1",
      status: "Approved",
    }),
    noSuite: await seedTestCase(api, projectId, {
      title: "Health endpoint responds",
      priority: "P3",
      status: "Approved",
      automationTags: "api",
    }),
    old: await seedTestCase(api, projectId, {
      title: "Legacy case authored six weeks ago",
      suiteId: alphaSuiteId,
      priority: "P2",
      status: "Deprecated",
      createdDaysAgo: 40,
    }),
  };

  const runs: SeededRun[] = [];
  for (let i = 0; i < RUN_AGES_IN_DAYS.length; i++) {
    runs.push(
      await seedRun(api, projectId, {
        // Only the first run carries the plan, so grouping by plan has a named group and a "No Plan" one.
        name: `E2E Reports Run ${i + 1}`,
        planId: i === 0 ? planId : undefined,
        createdDaysAgo: RUN_AGES_IN_DAYS[i],
      }),
    );
  }

  const expectedRunTotals = new Map<string, number>();
  const results: { executionId: string; status: string; executedDaysAgo: number; assigneeId?: string | null }[] = [];

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const caseIds = [cases.flaky.id];
    if (i < 6) caseIds.push(cases.stable.id, cases.lowFlake.id);
    if (i === 0) caseIds.push(cases.old.id);
    if (i === runs.length - 1) caseIds.push(cases.noSuite.id);
    await addRunCases(api, run.id, caseIds);
    expectedRunTotals.set(run.name, caseIds.length);

    const executions = await listRunExecutions(api, run.id);
    const executedDaysAgo = RUN_AGES_IN_DAYS[i];
    for (const execution of executions) {
      if (execution.testcaseId === cases.flaky.id) {
        results.push({ executionId: execution.id, status: i % 2 === 0 ? "Passed" : "Failed", executedDaysAgo });
      } else if (execution.testcaseId === cases.stable.id) {
        results.push({ executionId: execution.id, status: "Passed", executedDaysAgo, assigneeId: opts.assigneeId });
      } else if (execution.testcaseId === cases.lowFlake.id) {
        results.push({ executionId: execution.id, status: i === 5 ? "Failed" : "Passed", executedDaysAgo });
      } else if (execution.testcaseId === cases.noSuite.id) {
        results.push({ executionId: execution.id, status: "Passed", executedDaysAgo });
      }
      // cases.old keeps the Untested status its execution was auto-created with.
    }
  }
  setExecutionResults(results);

  const failedFlakyRun = runs[5];
  const failedFlakyExecutions = await listRunExecutions(api, failedFlakyRun.id);
  const failedFlakyExecution = failedFlakyExecutions.find((e) => e.testcaseId === cases.flaky.id)!;

  const stamp = Date.now();
  const bugTitles = {
    yesterday: `E2E Reports Bug yesterday ${stamp}`,
    twoWeeksAgo: `E2E Reports Bug two weeks ago ${stamp}`,
    longAgo: `E2E Reports Bug long ago ${stamp}`,
  };
  await seedBug(api, projectId, {
    title: bugTitles.yesterday,
    severity: "Critical",
    externalUrl: "https://example.invalid/bugs/E2E-1",
    links: [{ executionId: failedFlakyExecution.id, testcaseId: cases.flaky.id, cycleId: failedFlakyRun.id }],
    createdDaysAgo: 1,
  });
  await seedBug(api, projectId, { title: bugTitles.twoWeeksAgo, severity: "High", createdDaysAgo: 15 });
  await seedBug(api, projectId, { title: bugTitles.longAgo, severity: "Low", status: "Closed", createdDaysAgo: 80 });

  return { projectId, alphaSuiteId, betaSuiteId, planId, planName, cases, runs, expectedRunTotals, bugTitles };
}
