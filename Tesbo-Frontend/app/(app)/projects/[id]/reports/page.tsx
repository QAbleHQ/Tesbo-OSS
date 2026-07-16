"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { IconChevronRight, IconDownload } from "@tabler/icons-react";
import {
  authMe,
  getProject,
  getExecutionReport,
  getRequirementMatrix,
  getRepositorySummary,
  getReportsOverview,
  getReportsInsights,
  getReportsTrends,
  listPlans,
  listTestRuns,
  listSuites,
  listProjectMembers,
  listBugs,
  type ExecutionReportRow,
  type RequirementMatrixRow,
  type RepositorySummary,
  type ReportsOverview,
  type ReportsInsights,
  type ReportsTrends,
  type SuiteNode,
} from "@/lib/api";
import { useTopBarSlots } from "@/components/TopBarSlots";
import { ReportsNav, type ReportView } from "@/components/reports/ReportsNav";
import { OverviewTab } from "@/components/reports/OverviewTab";
import { ExecutionReportTab } from "@/components/reports/ExecutionReportTab";
import { TraceabilityTab } from "@/components/reports/TraceabilityTab";
import { RepositoryTab } from "@/components/reports/RepositoryTab";
import { AIInsightsTab } from "@/components/reports/AIInsightsTab";
import { TrendsTab } from "@/components/reports/TrendsTab";

export default function ReportsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const { startEl: topBarStartEl, endEl: topBarEndEl, setFilled: setTopBarFilled } = useTopBarSlots();
  useEffect(() => {
    setTopBarFilled(true);
    return () => setTopBarFilled(false);
  }, [setTopBarFilled]);

  const [auth, setAuth] = useState<{ userId: string } | null>(null);
  const [projectName, setProjectName] = useState("");
  const [activeView, setActiveView] = useState<ReportView>("overview");

  // Shared filter-option lists (used by Execution Report tab)
  const [plans, setPlans] = useState<{ id: string; name: string }[]>([]);
  const [runs, setRuns] = useState<{ id: string; name: string }[]>([]);
  const [suites, setSuites] = useState<SuiteNode[]>([]);
  const [members, setMembers] = useState<{ userId: string; name: string; email: string }[]>([]);
  const [openBugCount, setOpenBugCount] = useState(0);

  // Overview + AI Insights are cheap aggregate queries — load eagerly so the header
  // stat chips and the nav's flaky-count badge are available regardless of active tab.
  const [overview, setOverview] = useState<ReportsOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [insights, setInsights] = useState<ReportsInsights | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(true);

  // Execution Report state
  const [execFilterBy, setExecFilterBy] = useState("overall");
  const [execFilterValue, setExecFilterValue] = useState("");
  const [execRows, setExecRows] = useState<ExecutionReportRow[]>([]);
  const [execLoading, setExecLoading] = useState(false);
  const [execView, setExecView] = useState<"chart" | "table">("chart");

  // Traceability state
  const [matrixRows, setMatrixRows] = useState<RequirementMatrixRow[]>([]);
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [matrixSearch, setMatrixSearch] = useState("");

  // Repository state
  const [repoSummary, setRepoSummary] = useState<RepositorySummary | null>(null);
  const [repoLoading, setRepoLoading] = useState(false);

  // Trends state
  const [trends, setTrends] = useState<ReportsTrends | null>(null);
  const [trendsLoading, setTrendsLoading] = useState(false);

  useEffect(() => {
    authMe().then((me) => {
      setAuth(me);
      if (!me) router.replace("/login");
    });
  }, [router]);

  useEffect(() => {
    if (!auth) return;
    Promise.all([
      getProject(projectId),
      listPlans(projectId),
      listTestRuns(projectId),
      listSuites(projectId),
      listProjectMembers(projectId),
      listBugs(projectId),
    ])
      .then(([project, pl, rn, su, mb, bugs]) => {
        setProjectName(String(project.name || ""));
        setPlans(Array.isArray(pl) ? pl.map((p) => ({ id: p.id, name: p.name })) : []);
        setRuns(Array.isArray(rn) ? rn.map((r) => ({ id: r.id, name: r.name })) : []);
        setSuites(su);
        setMembers(mb);
        setOpenBugCount(bugs.filter((b) => b.status === "Open" || b.status === "Reopened").length);
      })
      .catch(() => {});
  }, [auth, projectId]);

  useEffect(() => {
    if (!auth) return;
    setOverviewLoading(true);
    getReportsOverview(projectId).then(setOverview).catch(() => setOverview(null)).finally(() => setOverviewLoading(false));
    setInsightsLoading(true);
    getReportsInsights(projectId).then(setInsights).catch(() => setInsights(null)).finally(() => setInsightsLoading(false));
  }, [auth, projectId]);

  const loadExecReport = useCallback(() => {
    setExecLoading(true);
    const p: { filterBy?: string; filterValue?: string } = {};
    if (execFilterBy !== "overall") p.filterBy = execFilterBy;
    if (execFilterValue) p.filterValue = execFilterValue;
    getExecutionReport(projectId, p)
      .then((res) => setExecRows(res.rows))
      .catch(() => setExecRows([]))
      .finally(() => setExecLoading(false));
  }, [projectId, execFilterBy, execFilterValue]);

  useEffect(() => {
    if (auth && activeView === "execution") loadExecReport();
  }, [auth, activeView, loadExecReport]);

  useEffect(() => {
    if (auth && activeView === "matrix" && matrixRows.length === 0 && !matrixLoading) {
      setMatrixLoading(true);
      getRequirementMatrix(projectId).then((res) => setMatrixRows(res.rows)).catch(() => setMatrixRows([])).finally(() => setMatrixLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth, activeView, projectId]);

  useEffect(() => {
    if (auth && activeView === "repository" && !repoSummary && !repoLoading) {
      setRepoLoading(true);
      getRepositorySummary(projectId).then(setRepoSummary).catch(() => setRepoSummary(null)).finally(() => setRepoLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth, activeView, projectId]);

  useEffect(() => {
    if (auth && activeView === "trends" && !trends && !trendsLoading) {
      setTrendsLoading(true);
      getReportsTrends(projectId).then(setTrends).catch(() => setTrends(null)).finally(() => setTrendsLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth, activeView, projectId]);

  const headerStats = useMemo(() => {
    let passRate: number | null = null;
    if (overview) {
      const withRate = overview.passRateTrend.filter((p) => p.passRate !== null && p.executed > 0);
      const totalExecuted = withRate.reduce((sum, p) => sum + p.executed, 0);
      if (totalExecuted > 0) {
        const totalPassed = withRate.reduce((sum, p) => sum + Math.round(((p.passRate as number) / 100) * p.executed), 0);
        passRate = Math.round((totalPassed / totalExecuted) * 100);
      }
    }
    let coverage: number | null = null;
    if (insights) {
      const totalCases = insights.coverageBySuite.reduce((sum, c) => sum + c.total, 0);
      const totalCovered = insights.coverageBySuite.reduce((sum, c) => sum + c.covered, 0);
      coverage = totalCases > 0 ? Math.round((totalCovered / totalCases) * 100) : 0;
    }
    return { passRate, coverage };
  }, [overview, insights]);

  if (!auth) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-[var(--muted)]">Loading…</p>
      </div>
    );
  }

  return (
    <main className="tc-fullbleed flex flex-col pb-4 pr-4 pt-4" style={{ height: "calc(100vh - 3.5rem)" }}>
      <div className="flex min-h-0 flex-1 flex-col">
        {topBarStartEl &&
          createPortal(
            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[12px]">
              {projectName && (
                <>
                  <button type="button" onClick={() => router.push("/projects")} className="truncate text-[var(--muted-soft)] transition-colors hover:text-[var(--brand-primary)]">
                    {projectName}
                  </button>
                  <IconChevronRight size={12} stroke={1.75} className="shrink-0 text-[var(--muted-soft)]" />
                </>
              )}
              <span className="font-medium text-[var(--brand-primary)]">Reports</span>
            </nav>,
            topBarStartEl
          )}
        {topBarEndEl &&
          createPortal(
            <button
              type="button"
              title="Coming soon"
              className="flex h-[30px] cursor-not-allowed items-center gap-1.5 rounded-[6px] border-0 bg-[var(--surface-tertiary)] px-3.5 text-[12px] font-medium text-[var(--muted-soft)]"
            >
              <IconDownload size={13} stroke={1.75} />
              Export
            </button>,
            topBarEndEl
          )}

        {/* Title + summary stat chips */}
        <div className="mb-3 flex shrink-0 flex-wrap items-start justify-between gap-4 pl-4">
          <div>
            <h1 className="text-[20px] font-semibold leading-tight tracking-[-0.02em] text-[var(--foreground)]">Reports &amp; Insights</h1>
            <p className="mt-[3px] text-[13px] text-[var(--muted-soft)]">
              Execution analytics, traceability, and AI-powered intelligence{projectName ? ` · ${projectName}` : ""}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <div className="rounded-[7px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-center">
              <div className="text-[16px] font-semibold leading-tight tracking-tight" style={{ color: headerStats.passRate === null ? "var(--muted-soft)" : "var(--status-pass-text)" }}>
                {headerStats.passRate === null ? "—" : `${headerStats.passRate}%`}
              </div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Pass rate</div>
            </div>
            <div className="rounded-[7px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-center">
              <div className="text-[16px] font-semibold leading-tight tracking-tight text-[var(--foreground)]">{runs.length}</div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Runs</div>
            </div>
            <div className="rounded-[7px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-center">
              <div className="text-[16px] font-semibold leading-tight tracking-tight" style={{ color: openBugCount > 0 ? "var(--status-fail-text)" : "var(--foreground)" }}>
                {openBugCount}
              </div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Open bugs</div>
            </div>
            <div className="rounded-[7px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-center">
              <div className="text-[16px] font-semibold leading-tight tracking-tight" style={{ color: headerStats.coverage === null ? "var(--muted-soft)" : "var(--info-foreground)" }}>
                {headerStats.coverage === null ? "—" : `${headerStats.coverage}%`}
              </div>
              <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Coverage</div>
            </div>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 overflow-hidden rounded-r-xl border border-l-0 border-[var(--border)] bg-[var(--surface)]">
          <ReportsNav activeView={activeView} onViewChange={setActiveView} flakyCount={insights?.flakyTests.length ?? 0} />

          <div className="min-w-0 flex-1 overflow-y-auto p-5">
            {activeView === "overview" && <OverviewTab overview={overview} loading={overviewLoading} />}
            {activeView === "execution" && (
              <ExecutionReportTab
                rows={execRows}
                loading={execLoading}
                filterBy={execFilterBy}
                filterValue={execFilterValue}
                onFilterByChange={(v) => { setExecFilterBy(v); setExecFilterValue(""); }}
                onFilterValueChange={setExecFilterValue}
                view={execView}
                onViewChange={setExecView}
                plans={plans}
                runs={runs}
                suites={suites}
                members={members}
              />
            )}
            {activeView === "matrix" && <TraceabilityTab rows={matrixRows} loading={matrixLoading} search={matrixSearch} onSearchChange={setMatrixSearch} />}
            {activeView === "repository" && <RepositoryTab summary={repoSummary} loading={repoLoading} />}
            {activeView === "insights" && <AIInsightsTab insights={insights} loading={insightsLoading} />}
            {activeView === "trends" && <TrendsTab trends={trends} loading={trendsLoading} />}
          </div>
        </div>
      </div>
    </main>
  );
}
