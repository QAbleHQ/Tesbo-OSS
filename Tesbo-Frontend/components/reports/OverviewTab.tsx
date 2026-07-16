"use client";

import { IconBrain, IconTrendingUp, IconTrendingDown, IconFlame, IconEyeOff, IconAlertCircle } from "@tabler/icons-react";
import type { ReportsOverview } from "@/lib/api";
import { TrendLineChart } from "./charts";
import { LoadingBlock } from "./shared";

function SuiteHealthBars({ rows }: { rows: ReportsOverview["suiteHealth"] }) {
  return (
    <div className="space-y-3">
      {rows.map((s) => (
        <div key={s.suiteName}>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[12px] text-[var(--muted)]">{s.suiteName}</span>
            <span
              className="font-mono text-[11px] font-medium"
              style={{ color: s.executed === 0 ? "var(--muted-soft)" : s.passedPct >= 70 ? "var(--status-pass-text)" : "var(--status-blocked-text)" }}
            >
              {s.executed === 0 ? "Not run" : `${s.passedPct}% pass`}
            </span>
          </div>
          <div className="flex h-1.5 overflow-hidden rounded-full bg-[var(--surface-secondary)]">
            {s.executed > 0 && (
              <>
                <div className="h-full" style={{ width: `${s.passedPct}%`, background: "var(--status-pass-dot)" }} />
                <div className="h-full" style={{ width: `${s.failedPct}%`, background: "var(--status-fail-dot)" }} />
                <div className="h-full" style={{ width: `${s.blockedPct}%`, background: "var(--status-blocked-dot)" }} />
              </>
            )}
          </div>
        </div>
      ))}
      {rows.length === 0 && <p className="py-4 text-center text-[13px] text-[var(--muted-soft)]">No suites yet</p>}
    </div>
  );
}

export function OverviewTab({ overview, loading }: { overview: ReportsOverview | null; loading: boolean }) {
  if (loading) return <LoadingBlock label="Loading overview…" />;
  if (!overview) return <LoadingBlock label="No data available." />;

  const trendPositive = overview.trendDelta >= 0;
  const points = overview.passRateTrend.map((p) => p.passRate);
  const labels = overview.passRateTrend.map((p) => new Date(p.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }));

  return (
    <div className="fade-in">
      <div className="mb-4">
        <div className="mb-0.5 text-[15px] font-semibold text-[var(--foreground)]">Overview</div>
        <div className="text-[12px] text-[var(--muted-soft)]">Across all suites and runs</div>
      </div>

      <div className="mb-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <div className="mb-3.5 flex items-center justify-between">
            <h3 className="text-[13px] font-semibold text-[var(--foreground)]">Pass rate trend</h3>
            {overview.passRateTrend.filter((p) => p.passRate !== null).length >= 2 && (
              <span
                className="flex items-center gap-1 text-[12px] font-medium"
                style={{ color: trendPositive ? "var(--status-pass-text)" : "var(--status-fail-text)" }}
              >
                {trendPositive ? <IconTrendingUp size={14} stroke={1.75} /> : <IconTrendingDown size={14} stroke={1.75} />}
                {trendPositive ? "+" : ""}{overview.trendDelta}%
              </span>
            )}
          </div>
          <TrendLineChart points={points} labels={labels} color="var(--status-pass-dot)" />
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <h3 className="mb-3.5 text-[13px] font-semibold text-[var(--foreground)]">Suite health</h3>
          <SuiteHealthBars rows={overview.suiteHealth} />
        </div>
      </div>

      {/* AI summary */}
      <div className="flex items-start gap-3.5 rounded-xl border border-[var(--ai-border)] bg-[var(--ai-soft)] p-5">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ai-surface)]">
          <IconBrain size={18} stroke={1.75} className="text-[var(--ai-primary)]" />
        </div>
        <div className="flex-1">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-[13px] font-semibold text-[var(--foreground)]">AI summary</span>
            <span className="rounded-full bg-[var(--ai-soft)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--ai-primary)]">AI</span>
          </div>
          <p className="text-[12.5px] leading-relaxed text-[var(--muted)]">{overview.aiSummary}</p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {overview.flakyCount > 0 && (
              <span className="flex items-center gap-1 rounded-full border border-[var(--status-fail-text)]/40 bg-[var(--status-fail-fill)] px-3 py-1 text-[11px] text-[var(--status-fail-text)]">
                <IconFlame size={12} stroke={1.75} /> {overview.flakyCount} flaky test{overview.flakyCount === 1 ? "" : "s"}
              </span>
            )}
            {overview.coverageGapCount > 0 && (
              <span className="flex items-center gap-1 rounded-full border border-[var(--status-blocked-text)]/40 bg-[var(--status-blocked-fill)] px-3 py-1 text-[11px] text-[var(--status-blocked-text)]">
                <IconEyeOff size={12} stroke={1.75} /> {overview.coverageGapCount} coverage gap{overview.coverageGapCount === 1 ? "" : "s"}
              </span>
            )}
            {overview.untestedP1Count > 0 && (
              <span className="flex items-center gap-1 rounded-full border border-[var(--info)]/40 bg-[var(--info-soft)] px-3 py-1 text-[11px] text-[var(--info-foreground)]">
                <IconAlertCircle size={12} stroke={1.75} /> {overview.untestedP1Count} untested P1{overview.untestedP1Count === 1 ? "" : "s"}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
