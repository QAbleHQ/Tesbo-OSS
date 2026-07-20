"use client";

import type { RepositorySummary } from "@/lib/api";
import { DonutChart, HorizontalBarChart, Legend, SUITE_PALETTE, PRIORITY_COLORS, TrendLineChart } from "./charts";
import { LoadingBlock } from "./shared";

const STATUS_DONUT_COLORS: Record<string, string> = {
  Draft: "var(--status-draft-dot)",
  Approved: "var(--status-pass-dot)",
  "In Review": "var(--status-inreview-dot)",
  Deprecated: "var(--status-skipped-dot)",
  Archived: "var(--muted-soft)",
};

const PRIORITY_LABELS: Record<string, string> = { P0: "P0 - Critical", P1: "P1 - High", P2: "P2 - Medium", P3: "P3 - Low" };

export function RepositoryTab({ summary, loading }: { summary: RepositorySummary | null; loading: boolean }) {
  if (loading) return <LoadingBlock label="Loading summary…" />;
  if (!summary) return <LoadingBlock label="No data available." />;

  return (
    <div className="fade-in">
      <div className="mb-4">
        <div className="mb-0.5 text-[15px] font-semibold text-[var(--foreground)]">Repository Summary</div>
        <div className="text-[12px] text-[var(--muted-soft)]">Test case inventory across all suites</div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-[12px] text-[var(--muted-soft)]">Total test cases</p>
          <p className="mt-1.5 text-[24px] font-bold leading-none text-[var(--foreground)]">{summary.totalTestCases}</p>
          <p className="mt-1.5 text-[11px] text-[var(--muted-soft)]">{summary.bySuite.length} suites</p>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-[12px] text-[var(--muted-soft)]">Updated today</p>
          <p className="mt-1.5 text-[24px] font-bold leading-none text-[var(--foreground)]">{summary.updatedToday}</p>
          <p className="mt-1.5 text-[11px] text-[var(--muted-soft)]">Last 24 hours</p>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-[12px] text-[var(--muted-soft)]">Updated this week</p>
          <p className="mt-1.5 text-[24px] font-bold leading-none text-[var(--foreground)]">{summary.updatedThisWeek}</p>
          <p className="mt-1.5 text-[11px] text-[var(--muted-soft)]">Since Monday</p>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-[12px] text-[var(--muted-soft)]">Updated this month</p>
          <p className="mt-1.5 text-[24px] font-bold leading-none text-[var(--foreground)]">{summary.updatedThisMonth}</p>
          <p className="mt-1.5 text-[11px] text-[var(--muted-soft)]">Since the 1st</p>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_280px]">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <h3 className="mb-4 text-[13px] font-semibold text-[var(--foreground)]">Test cases by suite</h3>
          <HorizontalBarChart data={summary.bySuite.map((s, i) => ({ label: s.name, value: s.count, color: SUITE_PALETTE[i % SUITE_PALETTE.length] }))} />
        </div>
        <div className="flex flex-col items-center rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
          <h3 className="mb-4 self-start text-[13px] font-semibold text-[var(--foreground)]">By status</h3>
          <DonutChart data={summary.byStatus.map((s) => ({ label: s.name, value: s.count, color: STATUS_DONUT_COLORS[s.name] || "var(--ai-primary)" }))} centerSub="cases" />
          <div className="mt-4">
            <Legend items={summary.byStatus.map((s) => ({ label: `${s.name} — ${s.count}`, color: STATUS_DONUT_COLORS[s.name] || "var(--ai-primary)" }))} />
          </div>
        </div>
      </div>

      <div className="mb-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <h3 className="mb-4 text-[13px] font-semibold text-[var(--foreground)]">Test cases added (last 30 days)</h3>
        <TrendLineChart
          points={summary.addedByDate.map((d) => d.count)}
          labels={summary.addedByDate.map((d) => d.date.slice(5))}
          color="var(--info)"
        />
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <h3 className="mb-4 text-[13px] font-semibold text-[var(--foreground)]">Test cases by priority</h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {summary.byPriority.map((p) => (
            <div key={p.name} className="rounded-lg border border-[var(--border)] p-4 text-center">
              <p className="text-[20px] font-bold" style={{ color: PRIORITY_COLORS[p.name] || "var(--muted-soft)" }}>{p.count}</p>
              <p className="mt-1 text-[11px] font-medium text-[var(--muted-soft)]">{PRIORITY_LABELS[p.name] || p.name}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
