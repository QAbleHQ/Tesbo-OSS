"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  IconArrowsSort,
  IconChevronDown,
  IconFilter,
  IconFolders,
  IconLayoutGrid,
  IconList,
  IconPlus,
} from "@tabler/icons-react";
import { authMe, listProjects, listTestCases, listSuites, createProject, getWorkspace, listActivity, listProjectMembers, listTestRuns } from "@/lib/api";
import type { ProjectSummary, ProjectType } from "@/lib/api";
import type { SuiteNode } from "@/lib/api";
import {
  Button,
  Card,
  EmptyStateBlock,
  Field,
  FieldHint,
  FieldLabel,
  Input,
  Modal,
  Textarea,
} from "@/components/ui";
import { ListWorkspaceLayout, PageHeader } from "@/components/workflows";

type RunCounts = { passed: number; failed: number; blocked: number; total: number };
type ProjectStatus = "active" | "configured" | "setup_required";

type ProjectWithStats = ProjectSummary & {
  testCaseCount: number;
  suites: SuiteNode[];
  teamMembers: { userId: string; name: string }[];
  lastActivityAt: string | null;
  status: ProjectStatus;
  runCounts: RunCounts | null; // latest completed run's breakdown, null if no runs
  currentPassRate: number | null; // latest run's pass %, null if no runs
};

const VIEW_STORAGE_KEY = "tesbo_projects_view";

const PROJECT_COLORS = ["#7C5FCC", "#4C5FD5", "#2D9A52", "#1D7FA8", "#D97C0A", "#D83A3A"];

function hashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function projectColor(seed: string): string {
  return PROJECT_COLORS[hashSeed(seed) % PROJECT_COLORS.length];
}

const STATUS_META: Record<ProjectStatus, { label: string; text: string; dot: string; fill: string }> = {
  active: { label: "Active", text: "var(--status-pass-text)", dot: "var(--status-pass-dot)", fill: "var(--status-pass-fill)" },
  configured: { label: "Configured", text: "var(--status-notrun-text)", dot: "var(--status-notrun-dot)", fill: "var(--status-notrun-fill)" },
  setup_required: { label: "Setup required", text: "var(--status-blocked-text)", dot: "var(--status-blocked-dot)", fill: "var(--status-blocked-fill)" },
};

function passRateTextColor(rate: number | null): string {
  if (rate === null) return "var(--muted-soft)";
  if (rate >= 90) return "var(--success)";
  if (rate >= 70) return "var(--warning)";
  return "var(--error)";
}

function formatRelativeTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "just now";
  const diffMs = Date.now() - ts;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "just now";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)}m ago`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)}h ago`;
  return `${Math.floor(diffMs / day)}d ago`;
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "U";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

function PassRateBar({ counts }: { counts: RunCounts }) {
  const { passed, failed, blocked, total } = counts;
  if (total <= 0) return null;
  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;
  return (
    <div className="mt-3.5">
      <div className="flex h-[5px] gap-0.5 overflow-hidden rounded-full bg-[var(--surface-secondary)]">
        {passed > 0 && <div className="h-full" style={{ width: pct(passed), background: "var(--status-pass-dot)" }} />}
        {failed > 0 && <div className="h-full" style={{ width: pct(failed), background: "var(--status-fail-dot)" }} />}
        {blocked > 0 && <div className="h-full" style={{ width: pct(blocked), background: "var(--status-blocked-dot)" }} />}
      </div>
      <div className="mt-2 flex flex-wrap gap-3">
        <span className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--status-pass-dot)" }} />
          {passed} passed
        </span>
        <span className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--status-fail-dot)" }} />
          {failed} failed
        </span>
        {blocked > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--status-blocked-dot)" }} />
            {blocked} blocked
          </span>
        )}
      </div>
    </div>
  );
}

function TeamAvatars({ team }: { team: { userId: string; name: string }[] }) {
  if (team.length === 0) return <span className="text-xs text-[var(--muted)]">No members assigned</span>;
  return (
    <div className="flex items-center">
      {team.slice(0, 4).map((member, idx) => (
        <span
          key={member.userId}
          className={`inline-flex h-6 w-6 items-center justify-center rounded-full border-2 border-[var(--surface)] text-[10px] font-semibold text-white ${idx > 0 ? "-ml-1.5" : ""}`}
          style={{ background: projectColor(member.userId) }}
          title={member.name}
        >
          {getInitials(member.name)}
        </span>
      ))}
      {team.length > 4 ? (
        <span className="-ml-1.5 inline-flex h-6 min-w-6 items-center justify-center rounded-full border-2 border-[var(--surface)] bg-[var(--surface-tertiary)] px-1.5 text-[10px] font-semibold text-[var(--foreground)]">
          +{team.length - 4}
        </span>
      ) : null}
    </div>
  );
}

function StatusBadge({ status }: { status: ProjectStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium"
      style={{ background: meta.fill, color: meta.text }}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: meta.dot }} />
      {meta.label}
    </span>
  );
}

function ProjectsToolbar({ viewMode, onViewModeChange }: { viewMode: "grid" | "list"; onViewModeChange: (v: "grid" | "list") => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex h-8 items-center gap-1.5 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] text-[var(--muted)] transition-colors hover:border-[var(--brand-primary)]"
        >
          <IconArrowsSort size={14} stroke={1.75} className="text-[var(--muted-soft)]" />
          Sort: Last updated
          <IconChevronDown size={13} stroke={1.75} className="text-[var(--muted-soft)]" />
        </button>
        <button
          type="button"
          className="flex h-8 items-center gap-1.5 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] text-[var(--muted)] transition-colors hover:border-[var(--brand-primary)]"
        >
          <IconFilter size={14} stroke={1.75} className="text-[var(--muted-soft)]" />
          Filter
        </button>
      </div>
      <div className="flex items-center gap-0.5 rounded-[6px] bg-[var(--surface-secondary)] p-[3px]">
        <button
          type="button"
          onClick={() => onViewModeChange("grid")}
          aria-label="Grid view"
          aria-pressed={viewMode === "grid"}
          className="flex h-[26px] w-7 items-center justify-center rounded-[4px] transition-colors"
          style={{ background: viewMode === "grid" ? "var(--surface)" : "transparent", color: viewMode === "grid" ? "var(--brand-primary)" : "var(--muted-soft)" }}
        >
          <IconLayoutGrid size={15} stroke={1.75} />
        </button>
        <button
          type="button"
          onClick={() => onViewModeChange("list")}
          aria-label="List view"
          aria-pressed={viewMode === "list"}
          className="flex h-[26px] w-7 items-center justify-center rounded-[4px] transition-colors"
          style={{ background: viewMode === "list" ? "var(--surface)" : "transparent", color: viewMode === "list" ? "var(--brand-primary)" : "var(--muted-soft)" }}
        >
          <IconList size={15} stroke={1.75} />
        </button>
      </div>
    </div>
  );
}

function ProjectsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [projects, setProjects] = useState<ProjectWithStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createKey, setCreateKey] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState("");
  const [workspaceRole, setWorkspaceRole] = useState<string>("");
  const canCreateProject = workspaceRole === "owner" || workspaceRole === "admin" || workspaceRole === "manager";

  useEffect(() => {
    const saved = localStorage.getItem(VIEW_STORAGE_KEY);
    if (saved === "grid" || saved === "list") setViewMode(saved);
  }, []);

  function handleViewModeChange(next: "grid" | "list") {
    setViewMode(next);
    localStorage.setItem(VIEW_STORAGE_KEY, next);
  }

  useEffect(() => {
    if (canCreateProject && searchParams.get("create") === "1") {
      setCreateOpen(true);
    }
  }, [canCreateProject, searchParams]);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      Promise.all([getWorkspace(), listProjects()])
        .then(async ([workspace, list]) => {
          setWorkspaceRole((workspace.role || "").toLowerCase());
          const withStats = await Promise.all(
            list.map(async (p) => {
              const [tcRes, suites, activity, members, runs] = await Promise.all([
                listTestCases(p.id, { limit: 1 }),
                listSuites(p.id),
                listActivity(p.id, { limit: 1 }),
                listProjectMembers(p.id),
                listTestRuns(p.id).catch(() => []),
              ]);
              const lastActivityAt = activity.list[0]?.createdAt ?? null;
              const status: ProjectWithStats["status"] =
                tcRes.total === 0 ? "setup_required" : (lastActivityAt ? "active" : "configured");

              const completedRuns = [...runs]
                .filter((r) => r.totalCases > 0)
                .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
              const latestRun = completedRuns[completedRuns.length - 1];
              const runCounts: RunCounts | null = latestRun
                ? {
                    passed: latestRun.passed,
                    failed: latestRun.failed,
                    blocked: Math.max(0, latestRun.totalCases - latestRun.passed - latestRun.failed),
                    total: latestRun.totalCases,
                  }
                : null;
              const currentPassRate = latestRun
                ? Math.round((latestRun.passed / latestRun.totalCases) * 100)
                : null;

              return {
                ...p,
                projectType: (p.projectType || "tesbox") as ProjectType,
                testCaseCount: tcRes.total,
                suites,
                teamMembers: members.map((m) => ({ userId: m.userId, name: m.name || m.email || "Unknown User" })),
                lastActivityAt,
                status,
                runCounts,
                currentPassRate,
              };
            })
          );
          setProjects(withStats);
        })
        .finally(() => setLoading(false));
    });
  }, [router]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError("");
    if (!canCreateProject) {
      setCreateError("Only workspace owner, admin, or manager can create projects.");
      return;
    }
    if (!createName.trim()) {
      setCreateError("Project name is required");
      return;
    }
    setCreateLoading(true);
    try {
      const created = await createProject({
        name: createName.trim(),
        key: createKey.trim() || undefined,
        description: createDescription.trim() || undefined,
        projectType: "tesbox",
      });
      setCreateOpen(false);
      setCreateName("");
      setCreateKey("");
      setCreateDescription("");
      router.push(`/projects/${created.id}/dashboard`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setCreateLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--ink-200)] border-t-[var(--denim)]" />
          <p className="text-[13px] text-[var(--ink-400)]">Loading projects…</p>
        </div>
      </div>
    );
  }

  return (
    <ListWorkspaceLayout
      header={(
        <PageHeader
          title="Projects"
          subtitle="Tesbo Test Manager end-to-end test management projects."
          actions={canCreateProject ? (
            <Button onClick={() => setCreateOpen(true)}>
              <IconPlus size={16} stroke={2} />
              {projects.length === 0 ? "Create your first project" : "Create project"}
            </Button>
          ) : null}
        />
      )}
      filterBar={projects.length > 0 ? <ProjectsToolbar viewMode={viewMode} onViewModeChange={handleViewModeChange} /> : null}
    >
      {projects.length === 0 ? (
        <EmptyStateBlock
          title="No projects yet"
          description={
            canCreateProject
              ? "Create a Tesbo Test Manager project for full E2E test management."
              : "You do not have project access yet. Ask your manager to grant access."
          }
          action={canCreateProject ? (
            <Button onClick={() => setCreateOpen(true)}>
              <IconPlus size={16} stroke={2} />
              Create first project
            </Button>
          ) : null}
        />
      ) : null}

      <Modal open={createOpen} onClose={() => !createLoading && setCreateOpen(false)} title="Create project">
        <form onSubmit={handleCreate} className="space-y-5">
          <Field>
            <FieldLabel htmlFor="create-name">Name *</FieldLabel>
            <Input
                  id="create-name"
                  type="text"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="My Project"
                  disabled={createLoading}
                  autoFocus
                />
          </Field>
          <Field>
            <FieldLabel htmlFor="create-key">Key (optional)</FieldLabel>
            <Input
                  id="create-key"
                  type="text"
                  value={createKey}
                  onChange={(e) => setCreateKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                  placeholder="PROJ"
                  className="font-mono"
                  disabled={createLoading}
                />
            <FieldHint>Short code; derived from name if blank.</FieldHint>
          </Field>
          <Field>
            <FieldLabel htmlFor="create-desc">Description (optional)</FieldLabel>
            <Textarea
                  id="create-desc"
                  value={createDescription}
                  onChange={(e) => setCreateDescription(e.target.value)}
                  rows={2}
                  disabled={createLoading}
                />
          </Field>
          {createError && <p className="text-sm text-red-600">{createError}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => !createLoading && setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={createLoading}>
              {createLoading ? "Creating…" : "Create project"}
            </Button>
          </div>
        </form>
      </Modal>

      {projects.length > 0 && (
        <div className="mt-6">
          <div className="mb-4 flex items-center gap-2">
            <IconFolders size={15} stroke={1.75} className="text-[var(--muted-soft)]" />
            <span className="text-xs font-medium uppercase tracking-[0.06em] text-[var(--muted)]">Tesbo Test Manager Projects</span>
            <span className="rounded-full bg-[var(--surface-secondary)] px-2 py-0.5 text-[11px] font-medium text-[var(--muted)]">{projects.length}</span>
          </div>

          {viewMode === "grid" ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((p) => {
                const color = projectColor(p.id);
                return (
                  <Link key={p.id} href={`/projects/${p.id}/dashboard`} className="group block">
                    <Card className="flex h-full flex-col overflow-hidden p-0 transition hover:border-[var(--border-strong)]">
                      <div className="border-b border-[var(--border-subtle)] p-5">
                        <div className="mb-2.5 flex items-start gap-3">
                          <div
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-white"
                            style={{ background: color }}
                          >
                            {p.name.trim().charAt(0).toUpperCase() || "P"}
                          </div>
                          <div className="min-w-0 flex-1">
                            <h2 className="truncate text-[15px] font-medium leading-5 text-[var(--foreground)] group-hover:text-[var(--brand-primary)]">
                              {p.name}
                            </h2>
                            <span className="mt-0.5 block font-mono text-[11px] uppercase tracking-wide text-[var(--muted-soft)]">
                              {p.key}
                            </span>
                          </div>
                          <StatusBadge status={p.status} />
                        </div>
                        <p className="line-clamp-2 text-[13px] leading-6 text-[var(--muted)]">
                          {p.description || "Add project context to guide test case planning and execution."}
                        </p>
                      </div>

                      <div className="border-b border-[var(--border-subtle)] p-5">
                        <div className="grid grid-cols-3 gap-2">
                          <div className="border-r border-[var(--border-subtle)] pr-2 text-center">
                            <div className="text-xl font-semibold tracking-tight text-[var(--foreground)]">{p.testCaseCount}</div>
                            <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Test cases</div>
                          </div>
                          <div className="border-r border-[var(--border-subtle)] px-2 text-center">
                            <div className="text-xl font-semibold tracking-tight text-[var(--foreground)]">{p.suites.length}</div>
                            <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Suites</div>
                          </div>
                          <div className="pl-2 text-center">
                            <div className="text-xl font-semibold tracking-tight" style={{ color: passRateTextColor(p.currentPassRate) }}>
                              {p.currentPassRate !== null ? `${p.currentPassRate}%` : "—"}
                            </div>
                            <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Pass rate</div>
                          </div>
                        </div>
                        {p.runCounts ? <PassRateBar counts={p.runCounts} /> : null}
                      </div>

                      <div className="flex items-center justify-between gap-3 p-5">
                        <TeamAvatars team={p.teamMembers} />
                        <span className="whitespace-nowrap font-mono text-[11px] text-[var(--muted-soft)]">
                          {p.lastActivityAt ? formatRelativeTime(p.lastActivityAt) : `Created ${formatRelativeTime(p.createdAt)}`}
                        </span>
                      </div>
                    </Card>
                  </Link>
                );
              })}
            </div>
          ) : (
            <Card className="overflow-hidden p-0">
              <div
                className="grid items-center gap-0 border-b border-[var(--border-subtle)] px-5 py-2.5"
                style={{ gridTemplateColumns: "1fr 90px 70px 110px 160px 100px" }}
              >
                <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Project</div>
                <div className="text-center text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Test cases</div>
                <div className="text-center text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Suites</div>
                <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Pass rate</div>
                <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Team</div>
                <div className="text-right text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Updated</div>
              </div>
              {projects.map((p) => {
                const color = projectColor(p.id);
                return (
                  <Link key={p.id} href={`/projects/${p.id}/dashboard`} className="group block">
                    <div
                      className="grid items-center gap-0 border-b border-[var(--border-subtle)] px-5 py-3 transition-colors last:border-b-0 hover:bg-[var(--surface-secondary)]"
                      style={{ gridTemplateColumns: "1fr 90px 70px 110px 160px 100px" }}
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold text-white" style={{ background: color }}>
                          {p.name.trim().charAt(0).toUpperCase() || "P"}
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium text-[var(--foreground)] group-hover:text-[var(--brand-primary)]">{p.name}</div>
                          <div className="font-mono text-[11px] uppercase text-[var(--muted-soft)]">{p.key}</div>
                        </div>
                      </div>
                      <div className="text-center text-[13px] font-medium text-[var(--foreground)]">{p.testCaseCount}</div>
                      <div className="text-center text-[13px] font-medium text-[var(--foreground)]">{p.suites.length}</div>
                      <div>
                        {p.currentPassRate !== null ? (
                          <div className="flex items-center gap-2">
                            <div className="h-1 max-w-[60px] flex-1 overflow-hidden rounded-full bg-[var(--surface-secondary)]">
                              <div className="h-full rounded-full" style={{ width: `${p.currentPassRate}%`, background: "var(--status-pass-dot)" }} />
                            </div>
                            <span className="text-xs font-medium" style={{ color: passRateTextColor(p.currentPassRate) }}>{p.currentPassRate}%</span>
                          </div>
                        ) : (
                          <span className="text-xs text-[var(--muted-soft)]">No runs yet</span>
                        )}
                      </div>
                      <TeamAvatars team={p.teamMembers} />
                      <div className="text-right font-mono text-[11px] text-[var(--muted-soft)]">
                        {p.lastActivityAt ? formatRelativeTime(p.lastActivityAt) : formatRelativeTime(p.createdAt)}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </Card>
          )}
        </div>
      )}
    </ListWorkspaceLayout>
  );
}

export default function ProjectsPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <p className="text-[var(--muted)]">Loading…</p>
        </div>
      }
    >
      <ProjectsPageContent />
    </Suspense>
  );
}
