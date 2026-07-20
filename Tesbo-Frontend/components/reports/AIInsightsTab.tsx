"use client";

import { IconFlame, IconEyeOff, IconAlertCircle, IconMap } from "@tabler/icons-react";
import { StatusChip } from "@/components/ui";
import type { ReportsInsights } from "@/lib/api";
import { HealthGauge } from "./charts";
import { statusTone, LoadingBlock } from "./shared";

function CoverageHeatmap({ rows }: { rows: ReportsInsights["coverageBySuite"] }) {
  const tone = (pct: number) => (pct >= 70 ? "var(--success)" : pct >= 30 ? "var(--warning)" : "var(--error)");
  const bg = (pct: number) => (pct >= 70 ? "var(--success-soft)" : pct >= 30 ? "var(--warning-soft)" : "var(--error-soft)");
  const label = (pct: number) => (pct >= 70 ? "Good" : pct >= 30 ? "Low" : "Critical");
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <div key={r.suiteName} className="flex items-center gap-3.5">
          <span className="w-28 shrink-0 truncate text-right text-[12px] text-[var(--muted)]">{r.suiteName}</span>
          <div className="h-4 flex-1 overflow-hidden rounded bg-[var(--surface-secondary)]">
            <div className="h-full rounded" style={{ width: `${r.pct}%`, background: tone(r.pct), opacity: 0.75 }} />
          </div>
          <span className="w-9 shrink-0 text-right font-mono text-[11px]" style={{ color: tone(r.pct) }}>{r.pct}%</span>
          <span
            className="w-[58px] shrink-0 rounded-full px-2 py-0.5 text-center text-[10px] font-semibold"
            style={{ background: bg(r.pct), color: tone(r.pct) }}
          >
            {label(r.pct)}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-[var(--muted-soft)]">{r.covered}/{r.total}</span>
        </div>
      ))}
      {rows.length === 0 && <p className="py-4 text-center text-[13px] text-[var(--muted-soft)]">No suites yet</p>}
    </div>
  );
}

export function AIInsightsTab({ insights, loading }: { insights: ReportsInsights | null; loading: boolean }) {
  if (loading) return <LoadingBlock label="Loading insights…" />;
  if (!insights) return <LoadingBlock label="No data available." />;

  return (
    <div className="fade-in">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[15px] font-semibold text-[var(--foreground)]">AI Insights</span>
        <span className="rounded-full bg-[var(--ai-soft)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--ai-primary)]">AI</span>
      </div>
      <p className="mb-4 text-[12px] text-[var(--muted-soft)]">Automated intelligence from your execution data</p>

      <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-[180px_1fr]">
        <div className="flex flex-col items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="mb-2.5 text-center text-[10px] font-semibold uppercase tracking-wide text-[var(--muted-soft)]">Health score</div>
          <div className="h-[110px] w-[140px]"><HealthGauge score={insights.healthScore} /></div>
          <div
            className="mt-1.5 text-[12px] font-medium"
            style={{ color: insights.healthScore >= 70 ? "var(--success)" : insights.healthScore >= 40 ? "var(--warning)" : "var(--error)" }}
          >
            {insights.healthLabel}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          <div className="rounded-xl border border-[var(--status-fail-text)]/30 bg-[var(--surface)] p-3.5">
            <div className="mb-2 flex items-center gap-1.5">
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--status-fail-fill)]">
                <IconFlame size={14} stroke={1.75} className="text-[var(--status-fail-text)]" />
              </div>
              <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--status-fail-text)]">Flaky tests</span>
            </div>
            <div className="text-[22px] font-bold leading-none text-[var(--status-fail-text)]">{insights.flakyTests.length}</div>
            <div className="mt-1 text-[11px] leading-snug text-[var(--muted-soft)]">
              {insights.flakyTests[0] ? `${insights.flakyTests[0].externalId} alternated results across runs` : "None detected"}
            </div>
          </div>
          <div className="rounded-xl border border-[var(--status-blocked-text)]/30 bg-[var(--surface)] p-3.5">
            <div className="mb-2 flex items-center gap-1.5">
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--status-blocked-fill)]">
                <IconEyeOff size={14} stroke={1.75} className="text-[var(--status-blocked-text)]" />
              </div>
              <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--status-blocked-text)]">Coverage gaps</span>
            </div>
            <div className="text-[22px] font-bold leading-none text-[var(--status-blocked-text)]">{insights.coverageGaps.length}</div>
            <div className="mt-1 text-[11px] leading-snug text-[var(--muted-soft)]">
              {insights.coverageGaps.length > 0 ? insights.coverageGaps.map((c) => c.suiteName).join(" & ") + " below 70%" : "All suites well covered"}
            </div>
          </div>
          <div className="rounded-xl border border-[var(--info)]/30 bg-[var(--surface)] p-3.5">
            <div className="mb-2 flex items-center gap-1.5">
              <div className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--info-soft)]">
                <IconAlertCircle size={14} stroke={1.75} className="text-[var(--info-foreground)]" />
              </div>
              <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--info-foreground)]">Untested P1s</span>
            </div>
            <div className="text-[22px] font-bold leading-none text-[var(--info-foreground)]">{insights.untestedP1Count}</div>
            <div className="mt-1 text-[11px] leading-snug text-[var(--muted-soft)]">High-priority cases never executed</div>
          </div>
        </div>
      </div>

      {/* Flaky test detector */}
      <div className="mb-4 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div className="flex items-center gap-1.5">
            <IconFlame size={15} stroke={1.75} className="text-[var(--status-fail-text)]" />
            <span className="text-[13px] font-semibold text-[var(--foreground)]">Flaky test detector</span>
          </div>
          <span className="text-[11px] text-[var(--muted-soft)]">Inconsistent results across runs</span>
        </div>
        {insights.flakyTests.length === 0 ? (
          <p className="py-8 text-center text-[13px] text-[var(--muted-soft)]">No flaky tests detected yet</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full" style={{ minWidth: 640 }}>
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--surface-secondary)] text-left text-[10px] uppercase tracking-wider text-[var(--muted-soft)]">
                  <th className="px-4 py-2.5 font-medium">Test case</th>
                  <th className="px-4 py-2.5 font-medium">Title</th>
                  <th className="px-4 py-2.5 font-medium">Suite</th>
                  <th className="px-4 py-2.5 font-medium">Runs</th>
                  <th className="px-4 py-2.5 font-medium">Flakiness</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {insights.flakyTests.map((f) => (
                  <tr key={f.testcaseId}>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-[var(--muted)]">{f.externalId}</td>
                    <td className="max-w-[260px] px-4 py-2.5 text-[12.5px] text-[var(--foreground)]">{f.title}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-[12px] text-[var(--muted)]">{f.suiteName}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {f.runs.map((r, i) => (
                          <StatusChip key={i} tone={statusTone(r.status)}>{r.status}</StatusChip>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-[var(--surface-secondary)]">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: f.flakinessLabel === "High" ? "100%" : f.flakinessLabel === "Medium" ? "60%" : "30%",
                              background: f.flakinessLabel === "High" ? "var(--error)" : f.flakinessLabel === "Medium" ? "var(--warning)" : "var(--info)",
                            }}
                          />
                        </div>
                        <span
                          className="text-[11px] font-medium"
                          style={{ color: f.flakinessLabel === "High" ? "var(--error)" : f.flakinessLabel === "Medium" ? "var(--warning)" : "var(--info)" }}
                        >
                          {f.flakinessLabel}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Coverage heatmap */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="mb-3.5 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <IconMap size={15} stroke={1.75} className="text-[var(--warning)]" />
            <span className="text-[13px] font-semibold text-[var(--foreground)]">Coverage by suite</span>
          </div>
          <span className="text-[11px] text-[var(--muted-soft)]">% of cases executed at least once</span>
        </div>
        <CoverageHeatmap rows={insights.coverageBySuite} />
      </div>
    </div>
  );
}
