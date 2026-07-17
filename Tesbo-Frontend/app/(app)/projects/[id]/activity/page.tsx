"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useCallback, useMemo, type ReactNode } from "react";
import Link from "next/link";
import {
  IconActivity,
  IconBooks,
  IconBug,
  IconClipboardList,
  IconFileText,
  IconFolders,
  IconMessage,
  IconPaperclip,
  IconPlayerPlay,
  IconSearch,
  IconSparkles,
} from "@tabler/icons-react";
import {
  authMe,
  getActivitySummary,
  getProject,
  listActivity,
  listProjectMembers,
  type ActivitySummary,
  type ActivityLogItem,
} from "@/lib/api";
import { Button, Card, CardBody, EmptyStateBlock, Select, StatusChip, type StatusChipProps } from "@/components/ui";
import { cx } from "@/components/ui/cx";
import { OwnerAvatar } from "@/components/testplans/PlanCard";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

const TYPE_FILTERS = [
  { value: "", label: "All types" },
  { value: "testcase", label: "Test cases" },
  { value: "suite", label: "Suites" },
  { value: "plan", label: "Test plans" },
  { value: "cycle", label: "Test runs" },
  { value: "bug", label: "Bugs" },
  { value: "knowledge_folder,knowledge_document,knowledge_file", label: "Knowledge base" },
] as const;

const DATE_FILTERS = [
  { value: "", label: "All time" },
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
] as const;

function sinceFor(dateFilter: string): string | undefined {
  if (!dateFilter) return undefined;
  const now = new Date();
  if (dateFilter === "today") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return start.toISOString();
  }
  const days = dateFilter === "7d" ? 7 : 30;
  return new Date(now.getTime() - days * 86400000).toISOString();
}

// action -> [badge label, StatusChip tone]
const ACTION_META: Record<string, [string, StatusChipProps["tone"]]> = {
  created: ["Created", "success"],
  testcase_created: ["Created", "success"],
  zyra_created: ["Generated", "ai"],
  zyra_suite_created: ["Generated", "ai"],
  updated: ["Updated", "info"],
  testcase_updated: ["Updated", "info"],
  zyra_updated: ["Updated", "ai"],
  zyra_moved_to_suite: ["Moved", "ai"],
  zyra_archived: ["Archived", "ai"],
  deleted: ["Deleted", "error"],
  testcase_deleted: ["Deleted", "error"],
  testcase_bulk_updated: ["Bulk updated", "info"],
  testcase_bulk_deleted: ["Bulk deleted", "error"],
  approved: ["Approved", "success"],
  rejected: ["Rejected", "warning"],
  restored: ["Restored", "neutral"],
  restored_version: ["Restored", "neutral"],
  moved: ["Moved", "neutral"],
  renamed: ["Renamed", "neutral"],
  duplicated: ["Duplicated", "neutral"],
  uploaded: ["Uploaded", "info"],
  execution_evidence_uploaded: ["Evidence added", "info"],
  zyra_chat_ai_failed: ["AI error", "error"],
};

function actionMeta(action: string): [string, StatusChipProps["tone"]] {
  if (ACTION_META[action]) return ACTION_META[action];
  if (action.includes("delet")) return [titleCase(action), "error"];
  if (action.includes("approv")) return [titleCase(action), "success"];
  if (action.includes("reject") || action.includes("block")) return [titleCase(action), "warning"];
  if (action.startsWith("zyra")) return [titleCase(action.replace(/^zyra_/, "")), "ai"];
  if (action.includes("creat")) return [titleCase(action), "success"];
  if (action.includes("updat")) return [titleCase(action), "info"];
  return [titleCase(action), "neutral"];
}

function titleCase(action: string): string {
  return action
    .replace(/^testcase_/, "")
    .replace(/^zyra_/, "")
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const ENTITY_META: Record<string, [string, typeof IconFileText]> = {
  testcase: ["Test Case", IconFileText],
  suite: ["Suite", IconFolders],
  plan: ["Plan", IconClipboardList],
  cycle: ["Test Run", IconPlayerPlay],
  bug: ["Bug", IconBug],
  knowledge_folder: ["Folder", IconBooks],
  knowledge_document: ["Knowledge document", IconBooks],
  knowledge_file: ["File", IconPaperclip],
  execution: ["Execution", IconPlayerPlay],
  zyra_chat: ["Zyra chat", IconMessage],
};

function entityMeta(entityType: string): [string, typeof IconFileText] {
  return ENTITY_META[entityType] || [titleCase(entityType), IconFileText];
}

function safeParseDiff(diff: string | null): Record<string, unknown> | null {
  if (!diff) return null;
  try {
    const parsed = JSON.parse(diff);
    return typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Derives a one-line description only from fields that genuinely changed or were logged —
// never fabricates copy for actions with no real diff/reason data behind them.
function describeActivity(item: ActivityLogItem): string | null {
  const diff = safeParseDiff(item.diff);
  if (item.action === "testcase_updated" && diff?.before && diff?.after) {
    const before = diff.before as Record<string, unknown>;
    const after = diff.after as Record<string, unknown>;
    if (before.status !== after.status && after.status) return `Status changed to ${after.status}.`;
    if (before.priority !== after.priority && after.priority) return `Priority changed to ${after.priority}.`;
    if (before.suite_id !== after.suite_id) return "Moved to a different suite.";
  }
  if (diff?.reason && typeof diff.reason === "string") return diff.reason;
  if (item.action === "zyra_moved_to_suite" && typeof diff?.movedCount === "number") {
    return `Moved ${diff.movedCount} test case${diff.movedCount === 1 ? "" : "s"} to this suite.`;
  }
  if (item.action === "testcase_bulk_updated" && Array.isArray(diff?.testcaseIds)) {
    return `Bulk-updated ${(diff.testcaseIds as unknown[]).length} test case(s).`;
  }
  if (item.action === "testcase_bulk_deleted" && Array.isArray(diff?.testcaseIds)) {
    return `Deleted ${(diff.testcaseIds as unknown[]).length} test case(s).`;
  }
  if (item.action === "execution_evidence_uploaded" && Array.isArray(diff?.files)) {
    const count = (diff.files as unknown[]).length;
    return `${count} file${count === 1 ? "" : "s"} attached as evidence.`;
  }
  if (item.action === "zyra_chat_ai_failed" && typeof diff?.message === "string") {
    return diff.message;
  }
  return null;
}

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatAbsolute(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function groupByDate(items: ActivityLogItem[]): { label: string; items: ActivityLogItem[] }[] {
  const groups: Map<string, ActivityLogItem[]> = new Map();
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  for (const item of items) {
    const d = new Date(item.createdAt);
    let label: string;
    if (d.toDateString() === today.toDateString()) label = "Today";
    else if (d.toDateString() === yesterday.toDateString()) label = "Yesterday";
    else label = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(item);
  }
  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
}

function ZyraMark({ size = 32 }: { size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full"
      style={{ width: size, height: size, background: "linear-gradient(135deg, #7C5FCC 0%, #4F46E5 100%)" }}
    >
      <IconSparkles size={Math.round(size * 0.5)} stroke={1.9} className="text-white" />
    </div>
  );
}

function ActorAvatar({ item }: { item: ActivityLogItem }) {
  if (item.actorKind === "agent" && item.actorName) return <ZyraMark size={32} />;
  const name = item.actorName || item.actorEmail;
  if (name) return <OwnerAvatar name={name} />;
  return (
    <span
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
      style={{ background: "var(--surface-secondary)", color: "var(--muted)" }}
      title="System"
    >
      SY
    </span>
  );
}

const PAGE_SIZE = 30;

export default function ActivityPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [project, setProject] = useState<Record<string, unknown> | null>(null);
  const [members, setMembers] = useState<{ userId: string; name: string; email: string }[]>([]);
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [activities, setActivities] = useState<ActivityLogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [offset, setOffset] = useState(0);

  const [typeFilter, setTypeFilter] = useState("");
  const [actorFilter, setActorFilter] = useState("");
  const [dateFilter, setDateFilter] = useState("");
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const fetchActivities = useCallback(
    async (reset: boolean, currentOffset: number) => {
      if (reset) setLoading(true);
      else setLoadingMore(true);
      try {
        const res = await listActivity(projectId, {
          limit: PAGE_SIZE,
          offset: currentOffset,
          entityType: typeFilter || undefined,
          actorId: actorFilter || undefined,
          search: search || undefined,
          since: sinceFor(dateFilter),
        });
        setActivities((prev) => (reset ? res.list : [...prev, ...res.list]));
        setTotal(res.total);
        setOffset(currentOffset + res.list.length);
      } catch {
        if (reset) setActivities([]);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [projectId, typeFilter, actorFilter, search, dateFilter]
  );

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      getProject(projectId)
        .then((p) => setProject(p))
        .catch(() => router.replace("/projects"));
      listProjectMembers(projectId)
        .then((list) => setMembers(list))
        .catch(() => setMembers([]));
      getActivitySummary(projectId)
        .then((s) => setSummary(s))
        .catch(() => setSummary(null));
    });
  }, [projectId, router]);

  useEffect(() => {
    fetchActivities(true, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, typeFilter, actorFilter, search, dateFilter]);

  const hasMore = activities.length < total;
  const groups = useMemo(() => groupByDate(activities), [activities]);
  const projectName = project ? ((project.name as string) ?? "") : "";

  const breadcrumb = (
    <>
      <Link href="/projects" className="hover:text-[var(--foreground)]">
        Projects
      </Link>
      <span>/</span>
      <Link href={`/projects/${projectId}/dashboard`} className="hover:text-[var(--foreground)]">
        {projectName}
      </Link>
      <span>/</span>
      <span>Activity</span>
    </>
  );

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Activity"
          subtitle="A full audit log of all actions taken across this project — who did what and when."
          breadcrumb={breadcrumb}
        />
      }
    >
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[1fr_280px]">
        <div className="min-w-0 space-y-6">
          {/* Filter toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-[150px]">
                <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                  {TYPE_FILTERS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="w-[150px]">
                <Select value={actorFilter} onChange={(e) => setActorFilter(e.target.value)}>
                  <option value="">Anyone</option>
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name || m.email}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="w-[130px]">
                <Select value={dateFilter} onChange={(e) => setDateFilter(e.target.value)}>
                  {DATE_FILTERS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <label className="flex h-9 w-full max-w-[240px] items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] text-[var(--muted)] transition-colors focus-within:border-[var(--denim-200)] sm:w-[240px]">
              <IconSearch size={14} stroke={1.75} className="shrink-0" />
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search activity…"
                className="min-w-0 flex-1 bg-transparent text-[var(--foreground)] outline-none placeholder:text-[var(--ink-300)]"
              />
            </label>
          </div>

          {/* Feed */}
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <svg className="h-6 w-6 animate-spin text-[var(--muted)]" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
          ) : activities.length === 0 ? (
            <EmptyStateBlock
              title="No activity yet"
              description="Actions like creating test cases, updating suites, and Zyra AI actions will appear here."
              icon={<IconActivity size={28} stroke={1.5} />}
            />
          ) : (
            <div className="space-y-1">
              {groups.map((group) => (
                <div key={group.label}>
                  <h3 className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--background)] py-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">
                    {group.label}
                  </h3>
                  <div className="divide-y divide-[var(--border-subtle)]">
                    {group.items.map((item) => (
                      <ActivityRow key={item.id} item={item} />
                    ))}
                  </div>
                </div>
              ))}

              {hasMore && (
                <div className="flex justify-center pt-5">
                  <Button variant="secondary" size="md" onClick={() => fetchActivities(false, offset)} disabled={loadingMore}>
                    {loadingMore ? "Loading…" : "Load more"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="lg:sticky lg:top-6">
          <ActivitySummaryPanel summary={summary} />
        </div>
      </div>
    </StandardPageLayout>
  );
}

function ActivityRow({ item }: { item: ActivityLogItem }) {
  const [badgeLabel, tone] = actionMeta(item.action);
  const [entityLabel, EntityIcon] = entityMeta(item.entityType);
  const actorDisplay = item.actorKind === "agent" ? item.actorName || "Zyra" : item.actorName || item.actorEmail || "System";
  const description = describeActivity(item);

  return (
    <div className="grid grid-cols-[32px_1fr_auto] items-start gap-3 py-3">
      <ActorAvatar item={item} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className="text-[13px] font-medium"
            style={{ color: item.actorKind === "agent" ? "var(--ai-primary)" : "var(--foreground)" }}
          >
            {actorDisplay}
          </span>
          <StatusChip tone={tone}>{badgeLabel}</StatusChip>
          <span className="flex items-center gap-1 text-[13px] text-[var(--muted)]">
            <EntityIcon size={13} stroke={1.75} />
            {entityLabel}
          </span>
          {item.entityName && <span className="text-[13px] font-medium text-[var(--foreground)]">{item.entityName}</span>}
        </div>
        {description && <p className="mt-1 text-[12px] text-[var(--muted-soft)]">{description}</p>}
      </div>
      <div className="shrink-0 text-right" title={formatAbsolute(item.createdAt)}>
        <div className="text-[12px] text-[var(--muted)]">{formatRelative(item.createdAt)}</div>
        <div className="mt-0.5 font-mono text-[11px] text-[var(--muted-soft)]">{formatAbsolute(item.createdAt)}</div>
      </div>
    </div>
  );
}

function SummaryCardHeader({ children }: { children: ReactNode }) {
  return (
    <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">{children}</div>
  );
}

const WEEKLY_ROWS: { key: keyof ActivitySummary["weekly"]; label: string; dot: string }[] = [
  { key: "created", label: "Created", dot: "bg-[var(--success)]" },
  { key: "updated", label: "Updated", dot: "bg-[var(--info)]" },
  { key: "aiActions", label: "AI Actions", dot: "bg-[var(--ai-primary)]" },
  { key: "deleted", label: "Deleted", dot: "bg-[var(--error)]" },
];

function ActivitySummaryPanel({ summary }: { summary: ActivitySummary | null }) {
  if (!summary || summary.weekly.total === 0) return null;
  const topMemberCount = summary.activeMembers[0]?.count || 1;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody className="p-4">
          <SummaryCardHeader>This week</SummaryCardHeader>
          <div className="flex flex-col">
            {WEEKLY_ROWS.map((row, i) => (
              <div
                key={row.key}
                className={cx(
                  "flex items-center justify-between py-2",
                  i < WEEKLY_ROWS.length - 1 && "border-b border-[var(--border-subtle)]"
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", row.dot)} aria-hidden />
                  <span className="text-[12px] text-[var(--muted)]">{row.label}</span>
                </div>
                <span className="text-[13px] font-semibold text-[var(--foreground)]">{summary.weekly[row.key]}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-[var(--border-subtle)] pt-3">
            <span className="text-[11px] text-[var(--muted)]">Total events</span>
            <span className="text-[13px] font-bold text-[var(--foreground)]">{summary.weekly.total}</span>
          </div>
        </CardBody>
      </Card>

      {summary.activeMembers.length > 0 && (
        <Card>
          <CardBody className="p-4">
            <SummaryCardHeader>Active members</SummaryCardHeader>
            <div className="flex flex-col gap-3">
              {summary.activeMembers.map((m) => {
                const isAgent = m.actorKind === "agent";
                const label = isAgent ? m.actorName || "Zyra AI" : m.actorName || m.actorEmail || "Unknown";
                const pct = Math.round((m.count / topMemberCount) * 100);
                return (
                  <div key={m.actorId} className="flex items-center gap-2.5">
                    {isAgent ? <ZyraMark size={24} /> : <OwnerAvatar name={label} />}
                    <div className="min-w-0 flex-1">
                      <div
                        className="truncate text-[12px] font-medium"
                        style={{ color: isAgent ? "var(--ai-primary)" : "var(--foreground)" }}
                      >
                        {label}
                      </div>
                      <div className="text-[11px] text-[var(--muted)]">
                        {m.count} action{m.count === 1 ? "" : "s"}
                      </div>
                    </div>
                    <div className="h-[3px] w-12 shrink-0 overflow-hidden rounded-full bg-[var(--surface-secondary)]">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${pct}%`, background: isAgent ? "var(--ai-primary)" : "var(--brand-primary)" }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </CardBody>
        </Card>
      )}

      {summary.byEntityType.length > 0 && (
        <Card>
          <CardBody className="p-4">
            <SummaryCardHeader>By entity type</SummaryCardHeader>
            <div className="flex flex-col gap-2.5">
              {summary.byEntityType.map((e) => {
                const [label, Icon] = entityMeta(e.entityType);
                return (
                  <div key={e.entityType} className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <Icon size={13} stroke={1.75} className="text-[var(--muted)]" />
                      <span className="text-[12px] text-[var(--muted)]">{label}</span>
                    </div>
                    <span className="text-[12px] font-medium text-[var(--foreground)]">{e.count}</span>
                  </div>
                );
              })}
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
