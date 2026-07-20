"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { IconSparkles, IconUser, IconX } from "@tabler/icons-react";
import { closeZyraTask, type ZyraTask } from "@/lib/api";
import { Button, StatusChip } from "@/components/ui";

export const JIRA_BADGE_CLASS =
  "rounded border border-[var(--border)] bg-[var(--surface-secondary)] px-2 py-0.5 font-mono text-[11px] font-medium text-[var(--muted)]";

export function normalizeTaskStatus(status: string): string {
  if (status === "accepted") return "done";
  if (status === "rejected") return "todo";
  return status || "todo";
}

export function taskStatusTone(status: string): "neutral" | "info" | "success" | "warning" {
  const normalized = normalizeTaskStatus(status);
  if (normalized === "done") return "success";
  if (normalized === "in_review") return "info";
  if (normalized === "in_progress") return "warning";
  return "neutral";
}

function priorityTone(priority: string): "error" | "warning" | "confidenceHigh" | "neutral" {
  if (priority === "P0") return "error";
  if (priority === "P1") return "warning";
  if (priority === "P2") return "confidenceHigh";
  return "neutral";
}

function firstStepText(stepsJson: string): string | null {
  try {
    const parsed = JSON.parse(stepsJson);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const first = parsed[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object") {
      return first.action || first.step || first.description || null;
    }
    return null;
  } catch {
    return null;
  }
}

type PanelTab = "testcases" | "feedback" | "sources" | "activity";

type TaskQuickViewPanelProps = {
  task: ZyraTask;
  projectId: string;
  onClose: () => void;
  onTaskUpdated: (task: ZyraTask) => void;
};

export default function TaskQuickViewPanel({ task, projectId, onClose, onTaskUpdated }: TaskQuickViewPanelProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>("testcases");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setActiveTab("testcases");
    setError(null);
  }, [task.id]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  const done = normalizeTaskStatus(task.taskStatus) === "done";
  const approvalRate = task.generatedCount > 0 ? Math.round((task.savedCount / task.generatedCount) * 100) : null;

  async function handleCloseTask() {
    setWorking(true);
    setError(null);
    try {
      const updated = await closeZyraTask(projectId, task.id);
      onTaskUpdated(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to close task.");
    } finally {
      setWorking(false);
    }
  }

  const tabs: Array<{ key: PanelTab; label: string; count?: number }> = [
    { key: "testcases", label: "Test cases", count: task.drafts.length },
    { key: "feedback", label: "Feedback" },
    { key: "sources", label: "Sources", count: task.sources.length },
    { key: "activity", label: "Activity", count: task.activities.length },
  ];

  return createPortal(
    <>
      <div role="presentation" className="fixed inset-0 z-40" onClick={onClose} />
      <div className="slide-in-right fixed right-0 top-0 z-50 flex h-screen w-full max-w-[520px] flex-col overflow-hidden border-l border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-elevated)]">
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--border)] p-5">
          <div className="min-w-0">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="font-mono text-xs text-[var(--muted-soft)]">{task.jiraIssueKeys[0] || "—"}</span>
              <StatusChip tone={taskStatusTone(task.taskStatus)}>{normalizeTaskStatus(task.taskStatus).replaceAll("_", " ")}</StatusChip>
            </div>
            <h2 className="line-clamp-2 text-[15px] font-semibold leading-snug text-[var(--foreground)]">{task.userStory}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-md p-1.5 text-[var(--muted-soft)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"
          >
            <IconX size={16} stroke={1.75} />
          </button>
        </div>

        {/* Stats row */}
        <div className="grid shrink-0 grid-cols-3 divide-x divide-[var(--border)] border-b border-[var(--border)]">
          <div className="p-3.5 text-center">
            <div className="font-mono text-lg font-semibold text-[var(--foreground)]">{task.generatedCount}</div>
            <div className="mt-0.5 text-[11px] text-[var(--muted-soft)]">Test cases</div>
          </div>
          <div className="p-3.5 text-center">
            <div className="font-mono text-lg font-semibold text-[var(--foreground)]">{task.tokenUsage.total}</div>
            <div className="mt-0.5 text-[11px] text-[var(--muted-soft)]">Tokens used</div>
          </div>
          <div className="p-3.5 text-center">
            <div
              className="font-mono text-lg font-semibold"
              style={{ color: approvalRate === null ? "var(--muted-soft)" : "var(--success)" }}
            >
              {approvalRate === null ? "—" : `${approvalRate}%`}
            </div>
            <div className="mt-0.5 text-[11px] text-[var(--muted-soft)]">Approval rate</div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex shrink-0 gap-5 border-b border-[var(--border)] px-5">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`border-b-2 py-2.5 text-[13px] font-medium transition-colors ${
                activeTab === tab.key
                  ? "border-[var(--brand-primary)] text-[var(--foreground)]"
                  : "border-transparent text-[var(--muted-soft)] hover:text-[var(--foreground)]"
              }`}
            >
              {tab.label}
              {tab.count != null ? ` (${tab.count})` : ""}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {error && (
            <p className="mb-3 rounded-lg border border-[var(--error)]/40 bg-[var(--error-soft)] px-3 py-2 text-sm text-[var(--error)]">{error}</p>
          )}

          {activeTab === "testcases" && (
            <div className="flex flex-col gap-2.5">
              {task.drafts.map((draft, index) => {
                const step = firstStepText(draft.stepsJson);
                return (
                  <div key={`${task.id}-draft-${index}`} className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3.5">
                    <div className="mb-1.5 flex items-center gap-2">
                      <StatusChip tone={priorityTone(draft.priority)}>{draft.priority}</StatusChip>
                      {draft.tags?.length ? <span className="text-[11px] text-[var(--muted-soft)]">{draft.tags.join(", ")}</span> : null}
                    </div>
                    <div className="text-[13px] font-medium leading-snug text-[var(--foreground)]">{draft.title}</div>
                    {step && <div className="mt-1.5 text-[12px] text-[var(--muted)]">1 → {step}</div>}
                  </div>
                );
              })}
              {task.drafts.length === 0 && <p className="text-sm text-[var(--muted)]">No generated testcases remain for this task.</p>}
            </div>
          )}

          {activeTab === "feedback" && (
            <div className="flex flex-col gap-3">
              {task.activities.map((activity, index) => {
                const isAgent = activity.actor === "agent";
                return (
                  <div
                    key={`${task.id}-feedback-${index}`}
                    className={`rounded-lg border border-[var(--border)] p-3.5 ${isAgent ? "border-l-[3px] border-l-[var(--brand-primary)]" : ""}`}
                    style={{ background: "var(--surface-secondary)" }}
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <div
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
                        style={isAgent ? { background: "linear-gradient(135deg, var(--brand-primary), var(--accent-light))" } : { background: "var(--ink-300)" }}
                      >
                        {isAgent ? <IconSparkles size={12} stroke={1.75} className="text-white" /> : <IconUser size={12} stroke={1.75} className="text-white" />}
                      </div>
                      <span className="text-[12px] font-medium text-[var(--foreground)]">{isAgent ? "Zyra" : "You"}</span>
                      <span className="ml-auto font-mono text-[11px] text-[var(--muted-soft)]">
                        {activity.createdAt ? new Date(activity.createdAt).toLocaleString() : ""}
                      </span>
                    </div>
                    <p className="text-[12px] leading-relaxed text-[var(--muted)]">{activity.detail || activity.title}</p>
                  </div>
                );
              })}
              {task.activities.length === 0 && <p className="text-sm text-[var(--muted)]">No activity recorded yet.</p>}
            </div>
          )}

          {activeTab === "sources" && (
            <div className="flex flex-col gap-2.5">
              {task.sources.map((source, index) => (
                <div key={`${task.id}-source-${index}`} className="rounded-lg border border-[var(--border)] p-3.5">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">{source.type.replaceAll("_", " ")}</span>
                  <h3 className="mt-1 text-[13px] font-semibold text-[var(--foreground)]">{source.title}</h3>
                  <p className="mt-1 text-[12px] text-[var(--muted)]">{source.detail}</p>
                </div>
              ))}
              {task.sources.length === 0 && <p className="text-sm text-[var(--muted)]">No source summary recorded.</p>}
            </div>
          )}

          {activeTab === "activity" && (
            <div className="flex flex-col gap-2.5">
              {task.activities.map((activity, index) => (
                <div key={`${task.id}-activity-${index}`} className="rounded-lg border border-[var(--border)] p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-soft)]">
                      {activity.actor} · {activity.stage.replaceAll("_", " ")}
                    </span>
                    <span className="font-mono text-[11px] text-[var(--muted-soft)]">
                      {activity.createdAt ? new Date(activity.createdAt).toLocaleString() : ""}
                    </span>
                  </div>
                  <h3 className="mt-1 text-[13px] font-semibold text-[var(--foreground)]">{activity.title}</h3>
                  <p className="mt-1 whitespace-pre-wrap text-[12px] text-[var(--muted)]">{activity.detail}</p>
                </div>
              ))}
              {task.activities.length === 0 && <p className="text-sm text-[var(--muted)]">No activity recorded yet.</p>}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 gap-2 border-t border-[var(--border)] p-4">
          <Link
            href={`/projects/${projectId}/agents/tasks/${task.id}`}
            className="flex flex-1 items-center justify-center rounded-[6px] border border-[var(--border)] px-4 text-[13px] font-medium text-[var(--foreground)] transition-colors hover:bg-[var(--surface-secondary)]"
            style={{ height: 34 }}
          >
            View full task
          </Link>
          <Button variant="secondary" style={{ height: 34 }} onClick={() => void handleCloseTask()} disabled={done || working}>
            {working ? "Closing…" : "Close task"}
          </Button>
        </div>
      </div>
    </>,
    document.body
  );
}
