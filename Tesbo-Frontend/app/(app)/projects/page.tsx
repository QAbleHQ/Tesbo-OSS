"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  IconArrowsSort,
  IconChevronDown,
  IconFolders,
  IconLayoutGrid,
  IconList,
  IconPlus,
  IconSearch,
} from "@tabler/icons-react";
import { authMe, listProjects, listTestCases, listSuites, createProject, getWorkspace, listActivity, listProjectMembers, listTestRuns } from "@/lib/api";
import type { ProjectSummary, ProjectType } from "@/lib/api";
import type { SuiteNode } from "@/lib/api";
import {
  Button,
  Card,
  EmptyStateBlock,
  Field,
  FieldError,
  FieldHint,
  FieldLabel,
  Input,
  Modal,
  Textarea,
} from "@/components/ui";
import { ListWorkspaceLayout, PageHeader } from "@/components/workflows";
import { readStoredValue, writeStoredValue } from "@/lib/storage";
import {
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  validateProjectDescription,
  validateProjectName,
} from "@/lib/validation";
import { avatarColor } from "@/lib/avatarColors";

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

/*
 * Avatar fills come from lib/avatarColors.ts.
 *
 * This module used to hold its own copy of the palette and its own hashSeed — byte-identical to the
 * shared ones, which is exactly how they drift apart. Basecamp 10198836413 ("Display picture initials
 * show different colours across the website") was that drift: one person's initials were painted five
 * different ways across the app.
 */

type SortOption = "updated" | "name_asc" | "name_desc" | "created";

const SORT_OPTIONS: Array<{ value: SortOption; label: string }> = [
  { value: "updated", label: "Last updated" },
  { value: "created", label: "Newest created" },
  { value: "name_asc", label: "Name (A–Z)" },
  { value: "name_desc", label: "Name (Z–A)" },
];

function sortProjects(projects: ProjectWithStats[], sortBy: SortOption): ProjectWithStats[] {
  const sorted = [...projects];
  switch (sortBy) {
    case "name_asc":
      return sorted.sort((a, b) => a.name.localeCompare(b.name));
    case "name_desc":
      return sorted.sort((a, b) => b.name.localeCompare(a.name));
    case "created":
      return sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    case "updated":
    default:
      return sorted.sort((a, b) => {
        const aTime = new Date(a.lastActivityAt ?? a.createdAt).getTime();
        const bTime = new Date(b.lastActivityAt ?? b.createdAt).getTime();
        return bTime - aTime;
      });
  }
}

function projectColor(seed: string): string {
  return avatarColor(seed);
}

const STATUS_META: Record<ProjectStatus, { label: string; text: string; dot: string; fill: string }> = {
  active: { label: "Active", text: "var(--status-pass-text)", dot: "var(--status-pass-dot)", fill: "var(--status-pass-fill)" },
  configured: { label: "Configured", text: "var(--status-notrun-text)", dot: "var(--status-notrun-dot)", fill: "var(--status-notrun-fill)" },
  setup_required: { label: "Setup required", text: "var(--status-blocked-text)", dot: "var(--status-blocked-dot)", fill: "var(--status-blocked-fill)" },
};

/*
 * The -foreground tokens, not the raw --success/--warning/--error fills: those are tuned to carry
 * white text as a background, and read at 3.1–4.0:1 when used as text on a light surface.
 */
function passRateTextColor(rate: number | null): string {
  if (rate === null) return "var(--muted-soft)";
  if (rate >= 90) return "var(--success-foreground)";
  if (rate >= 70) return "var(--warning-foreground)";
  return "var(--error-foreground)";
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

// "Total Suites" on a project card counts every suite — top-level and nested sub-suites alike.
function totalSuiteCount(suites: SuiteNode[]): number {
  return suites.length;
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

function SortMenu({ sortBy, onSortChange }: { sortBy: SortOption; onSortChange: (v: SortOption) => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const currentLabel = SORT_OPTIONS.find((o) => o.value === sortBy)?.label ?? "Last updated";

  useEffect(() => {
    if (!isOpen) return;
    function handleOutsideClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setIsOpen(false);
    }
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [isOpen]);

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-expanded={isOpen}
        className="flex h-8 items-center gap-1.5 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[13px] text-[var(--muted)] transition-colors hover:border-[var(--brand-primary)]"
      >
        <IconArrowsSort size={14} stroke={1.75} className="text-[var(--muted-soft)]" />
        Sort: {currentLabel}
        <IconChevronDown size={13} stroke={1.75} className="text-[var(--muted-soft)]" />
      </button>
      {isOpen && (
        <div className="absolute left-0 top-full z-40 mt-1 w-44 rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-[var(--shadow-elevated)]">
          {SORT_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onSortChange(option.value);
                setIsOpen(false);
              }}
              className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-[var(--surface-secondary)] ${
                option.value === sortBy ? "text-[var(--brand-primary)]" : "text-[var(--foreground)]"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectsToolbar({
  viewMode,
  onViewModeChange,
  searchQuery,
  onSearchChange,
  sortBy,
  onSortChange,
}: {
  viewMode: "grid" | "list";
  onViewModeChange: (v: "grid" | "list") => void;
  searchQuery: string;
  onSearchChange: (v: string) => void;
  sortBy: SortOption;
  onSortChange: (v: SortOption) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <label className="flex h-8 min-w-[200px] max-w-[280px] flex-1 items-center gap-1.5 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-2.5 text-[13px] text-[var(--muted-soft)] transition-colors focus-within:border-[var(--brand-primary)]">
          <IconSearch size={14} stroke={1.75} className="shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search projects by name or keyword"
            className="min-w-0 flex-1 bg-transparent text-[var(--foreground)] outline-none placeholder:text-[var(--muted-soft)]"
          />
        </label>
        <SortMenu sortBy={sortBy} onSortChange={onSortChange} />
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
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortOption>("updated");
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createKey, setCreateKey] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createNameError, setCreateNameError] = useState("");
  const [createDescriptionError, setCreateDescriptionError] = useState("");
  const [workspaceRole, setWorkspaceRole] = useState<string>("");
  const canCreateProject = workspaceRole === "owner" || workspaceRole === "admin" || workspaceRole === "manager";

  useEffect(() => {
    const saved = readStoredValue(VIEW_STORAGE_KEY);
    if (saved === "grid" || saved === "list") setViewMode(saved);
  }, []);

  function handleViewModeChange(next: "grid" | "list") {
    setViewMode(next);
    writeStoredValue(VIEW_STORAGE_KEY, next);
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
              /*
               * Each stat is caught on its own. A single rejection here used to take down the whole
               * Promise.all, leaving `projects` empty with loading already false — so one failing
               * suites/activity/members call showed the "No projects yet" onboarding state to a
               * user who has projects. A partial outage should degrade one card, not the list.
               */
              const [tcRes, suites, activity, members, runs] = await Promise.all([
                listTestCases(p.id, { limit: 1 }).catch(() => ({ list: [], total: 0 })),
                listSuites(p.id).catch(() => []),
                listActivity(p.id, { limit: 1 }).catch(() => ({ list: [], total: 0 })),
                listProjectMembers(p.id).catch(() => []),
                listTestRuns(p.id).catch(() => []),
              ]);
              const lastActivityAt = activity.list[0]?.createdAt ?? null;
              const status: ProjectWithStats["status"] =
                tcRes.total === 0 ? "setup_required" : (lastActivityAt ? "active" : "configured");

              /*
               * The card reports the most recent run that has actually been executed, and reports it
               * the same way the project dashboard does: passed over *executed*, never over total.
               *
               * Both halves of that mattered. Ranking by creation date alone meant scheduling an
               * empty run replaced a finished 100% run with an unstarted one, and dividing by
               * totalCases turned its nothing-executed-yet into "0%" — so the same project read 100%
               * on its dashboard and 0% here.
               */
              const executedCases = (r: (typeof runs)[number]) => Math.max(0, r.totalCases - r.untested);
              const executedRuns = [...runs]
                .filter((r) => executedCases(r) > 0)
                .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
              const latestRun = executedRuns[executedRuns.length - 1];
              const runCounts: RunCounts | null = latestRun
                ? {
                    passed: latestRun.passed,
                    failed: latestRun.failed,
                    // The run's own blocked count. Deriving it as total - passed - failed swept
                    // untested, skipped and retest into it, so an unexecuted case read as blocked.
                    blocked: latestRun.blocked,
                    total: latestRun.totalCases,
                  }
                : null;
              const currentPassRate = latestRun
                ? Math.round((latestRun.passed / executedCases(latestRun)) * 100)
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

  /*
   * Closing discards the draft. Leaving it behind meant reopening the modal showed the abandoned
   * name — so a fresh key could be typed against a stale name and submitted without the user ever
   * seeing what they were actually creating.
   */
  function closeCreate() {
    if (createLoading) return;
    setCreateOpen(false);
    setCreateName("");
    setCreateKey("");
    setCreateDescription("");
    setCreateError("");
    // Field-level validation errors have to go too, or reopening the modal shows a complaint about
    // input the user can no longer see.
    setCreateNameError("");
    setCreateDescriptionError("");
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError("");
    if (!canCreateProject) {
      setCreateError("Only workspace owner, admin, or manager can create projects.");
      return;
    }
    const nameError = validateProjectName(createName);
    if (nameError) {
      setCreateNameError(nameError);
      return;
    }
    const descriptionError = validateProjectDescription(createDescription);
    if (descriptionError) {
      setCreateDescriptionError(descriptionError);
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
      setCreateError("");
      setCreateNameError("");
      setCreateDescriptionError("");
      router.push(`/projects/${created.id}/dashboard`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setCreateLoading(false);
    }
  }

  const filteredProjects = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const matched = !query
      ? projects
      : projects.filter((p) =>
          [p.name, p.key, p.description ?? ""].some((field) => field.toLowerCase().includes(query))
        );
    return sortProjects(matched, sortBy);
  }, [projects, searchQuery, sortBy]);

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
      filterBar={
        projects.length > 0 ? (
          <ProjectsToolbar
            viewMode={viewMode}
            onViewModeChange={handleViewModeChange}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            sortBy={sortBy}
            onSortChange={setSortBy}
          />
        ) : null
      }
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

      {projects.length > 0 && filteredProjects.length === 0 ? (
        <EmptyStateBlock
          title="No projects match your search"
          description={`No projects found for "${searchQuery.trim()}". Try a different name or keyword.`}
        />
      ) : null}

      <Modal open={createOpen} onClose={closeCreate} title="Create project">
        <form onSubmit={handleCreate} className="space-y-5">
          <Field>
            <FieldLabel htmlFor="create-name">Name *</FieldLabel>
            <Input
                  id="create-name"
                  type="text"
                  value={createName}
                  onChange={(e) => {
                    const value = e.target.value;
                    setCreateName(value);
                    if (createNameError && !validateProjectName(value)) setCreateNameError("");
                  }}
                  placeholder="My Project"
                  disabled={createLoading}
                  maxLength={PROJECT_NAME_MAX_LENGTH}
                  autoFocus
                />
            {createNameError && <FieldError>{createNameError}</FieldError>}
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
                  onChange={(e) => {
                    const value = e.target.value;
                    setCreateDescription(value);
                    if (createDescriptionError && !validateProjectDescription(value)) setCreateDescriptionError("");
                  }}
                  rows={2}
                  disabled={createLoading}
                  maxLength={PROJECT_DESCRIPTION_MAX_LENGTH}
                />
            {createDescriptionError && <FieldError>{createDescriptionError}</FieldError>}
          </Field>
          {createError && <p className="text-sm text-red-600">{createError}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={closeCreate}>
              Cancel
            </Button>
            <Button type="submit" disabled={createLoading}>
              {createLoading ? "Creating…" : "Create project"}
            </Button>
          </div>
        </form>
      </Modal>

      {filteredProjects.length > 0 && (
        <div className="mt-6">
          <div className="mb-4 flex items-center gap-2">
            <IconFolders size={15} stroke={1.75} className="text-[var(--muted-soft)]" />
            <span className="text-xs font-medium uppercase tracking-[0.06em] text-[var(--muted)]">Tesbo Test Manager Projects</span>
            <span className="rounded-full bg-[var(--surface-secondary)] px-2 py-0.5 text-[11px] font-medium text-[var(--muted)]">{filteredProjects.length}</span>
          </div>

          {viewMode === "grid" ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredProjects.map((p) => {
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
                            <h2 className="truncate text-[15px] font-medium leading-5 text-[var(--foreground)] group-hover:text-[var(--accent-light)]">
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
                            <div className="text-xl font-semibold tracking-tight text-[var(--foreground)]">{totalSuiteCount(p.suites)}</div>
                            <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Total Suites</div>
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
                style={{ gridTemplateColumns: "1fr 90px 100px 110px 160px 100px" }}
              >
                <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Project</div>
                <div className="text-center text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Test cases</div>
                <div className="text-center text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Total Suites</div>
                <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Pass rate</div>
                <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Team</div>
                <div className="text-right text-[11px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Updated</div>
              </div>
              {filteredProjects.map((p) => {
                const color = projectColor(p.id);
                return (
                  <Link key={p.id} href={`/projects/${p.id}/dashboard`} className="group block">
                    <div
                      className="grid items-center gap-0 border-b border-[var(--border-subtle)] px-5 py-3 transition-colors last:border-b-0 hover:bg-[var(--surface-secondary)]"
                      style={{ gridTemplateColumns: "1fr 90px 100px 110px 160px 100px" }}
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold text-white" style={{ background: color }}>
                          {p.name.trim().charAt(0).toUpperCase() || "P"}
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium text-[var(--foreground)] group-hover:text-[var(--accent-light)]">{p.name}</div>
                          <div className="font-mono text-[11px] uppercase text-[var(--muted-soft)]">{p.key}</div>
                        </div>
                      </div>
                      <div className="text-center text-[13px] font-medium text-[var(--foreground)]">{p.testCaseCount}</div>
                      <div className="text-center text-[13px] font-medium text-[var(--foreground)]">{totalSuiteCount(p.suites)}</div>
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
