"use client";

import {
  IconLayoutDashboard,
  IconChartBar,
  IconTable,
  IconDatabase,
  IconBrain,
  IconTrendingUp,
  IconFileExport,
  IconTableExport,
} from "@tabler/icons-react";

export type ReportView = "overview" | "execution" | "matrix" | "repository" | "insights" | "trends";

const NAV_ITEMS: { id: ReportView; label: string; sub: string; icon: React.ComponentType<{ size?: number; stroke?: number; className?: string }> }[] = [
  { id: "overview", label: "Overview", sub: "KPI summary", icon: IconLayoutDashboard },
  { id: "execution", label: "Execution Report", sub: "Results by run", icon: IconChartBar },
  { id: "matrix", label: "Traceability", sub: "Req → TC → Bug", icon: IconTable },
  { id: "repository", label: "Repository", sub: "Test case stats", icon: IconDatabase },
];

function NavRow({
  active,
  icon: Icon,
  label,
  sub,
  badge,
  onClick,
}: {
  active: boolean;
  icon: React.ComponentType<{ size?: number; stroke?: number; className?: string }>;
  label: string;
  sub?: string;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`mb-0.5 flex w-full items-center gap-2 rounded-[6px] border-l-2 px-2 py-1.5 text-left transition-colors ${
        active ? "border-[var(--brand-primary)] bg-[var(--surface-secondary)]" : "border-transparent hover:bg-[var(--surface-secondary)]/60"
      }`}
    >
      <Icon size={15} stroke={1.75} className={active ? "text-[var(--accent-light)]" : "text-[var(--muted-soft)]"} />
      <div className="min-w-0 flex-1">
        <div className={`text-[12.5px] ${active ? "font-medium text-[var(--accent-light)]" : "text-[var(--ink-600)]"}`}>{label}</div>
        {sub && <div className="mt-px text-[10px] text-[var(--muted-soft)]">{sub}</div>}
      </div>
      {typeof badge === "number" && badge > 0 && (
        <span className="shrink-0 rounded-full bg-[var(--status-fail-fill)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--status-fail-text)]">{badge}</span>
      )}
    </button>
  );
}

export function ReportsNav({
  activeView,
  onViewChange,
  flakyCount,
}: {
  activeView: ReportView;
  onViewChange: (v: ReportView) => void;
  flakyCount: number;
}) {
  return (
    <aside className="flex w-[220px] shrink-0 flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--surface)]">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-[var(--border)] px-3">
        <IconChartBar size={14} stroke={1.75} className="text-[var(--accent-light)]" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--ink-600)]">Reports</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="px-1.5 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.07em] text-[var(--muted-soft)]">Analytics</div>

        {NAV_ITEMS.map((item) => (
          <NavRow
            key={item.id}
            active={activeView === item.id}
            icon={item.icon}
            label={item.label}
            sub={item.sub}
            onClick={() => onViewChange(item.id)}
          />
        ))}

        <div className="my-2 mx-1 h-px bg-[var(--border)]" />

        <div className="flex items-center gap-1.5 px-1.5 pb-1">
          <span className="text-[10px] font-semibold uppercase tracking-[0.07em] text-[var(--muted-soft)]">Intelligence</span>
          <span className="rounded-full bg-[var(--ai-soft)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--ai-primary)]">AI</span>
        </div>
        <NavRow active={activeView === "insights"} icon={IconBrain} label="AI Insights" sub="Risk · Flaky · Gaps" badge={flakyCount} onClick={() => onViewChange("insights")} />
        <NavRow active={activeView === "trends"} icon={IconTrendingUp} label="Trends" sub="Pass rate over time" onClick={() => onViewChange("trends")} />

        <div className="my-2 mx-1 h-px bg-[var(--border)]" />

        <div className="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.07em] text-[var(--muted-soft)]">Export</div>
        <div className="mb-0.5 flex w-full cursor-not-allowed items-center gap-2 rounded-[6px] px-2 py-1.5 text-[var(--muted-soft)]" title="Coming soon">
          <IconFileExport size={14} stroke={1.75} />
          <span className="text-[12.5px]">Export PDF</span>
        </div>
        <div className="flex w-full cursor-not-allowed items-center gap-2 rounded-[6px] px-2 py-1.5 text-[var(--muted-soft)]" title="Coming soon">
          <IconTableExport size={14} stroke={1.75} />
          <span className="text-[12.5px]">Export CSV</span>
        </div>
      </div>
    </aside>
  );
}
