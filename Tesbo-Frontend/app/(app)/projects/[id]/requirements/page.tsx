"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import React from "react";
import {
  authMe,
  getJiraStatus,
  createZyraTask,
  listJiraTickets,
  listLinkedJiraKeys,
  syncJiraTickets,
  type JiraTicket,
  type JiraConnection,
} from "@/lib/api";
import { Button, Input, StatusChip } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

const PAGE_SIZE = 25;

function jiraStatusTone(status: string): "neutral" | "success" | "warning" | "info" {
  const s = status.toLowerCase();
  if (s === "done" || s === "closed" || s === "resolved") return "success";
  if (s === "in progress" || s === "in review") return "info";
  if (s === "to do" || s === "open" || s === "new" || s === "backlog") return "neutral";
  return "warning";
}

function PriorityIcon({ priority }: { priority: string }) {
  const p = priority?.toLowerCase() ?? "";
  let color = "text-[var(--muted-soft)]";
  if (p === "highest" || p === "critical") color = "text-red-500";
  else if (p === "high") color = "text-orange-500";
  else if (p === "medium") color = "text-yellow-500";
  else if (p === "low") color = "text-[var(--brand-primary)]";
  else if (p === "lowest") color = "text-[var(--muted-soft)]";
  return (
    <span className={`text-xs font-medium ${color}`} title={priority}>
      {priority || "—"}
    </span>
  );
}

function IssueTypeIcon({ type }: { type: string }) {
  const t = type?.toLowerCase() ?? "";
  let color = "bg-[var(--surface-tertiary)] text-[var(--muted)]";
  if (t === "bug") color = "bg-[var(--error-soft)] text-[var(--error)]";
  else if (t === "story" || t === "user story")
    color = "bg-[var(--success-soft)] text-[var(--success)]";
  else if (t === "epic")
    color = "bg-[var(--ai-soft)] text-[var(--ai-primary)]";
  else if (t === "task" || t === "sub-task")
    color = "bg-[var(--brand-soft)] text-[var(--brand-primary)]";
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${color}`}>
      {type || "—"}
    </span>
  );
}

function SearchBar({
  value,
  onChange,
  onSearch,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSearch: () => void;
  placeholder?: string;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSearch();
      }}
      className="flex items-center gap-2"
    >
      <div className="relative flex-1">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-soft)]"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
        </svg>
        <Input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="pl-9"
        />
      </div>
      <Button type="submit" variant="secondary">Search</Button>
    </form>
  );
}

export default function RequirementsPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [loading, setLoading] = useState(true);
  const [jiraStatus, setJiraStatus] = useState<JiraConnection | null>(null);
  const [tickets, setTickets] = useState<JiraTicket[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [linkedJiraKeys, setLinkedJiraKeys] = useState<Set<string>>(new Set());
  const [jiraKeyCounts, setJiraKeyCounts] = useState<Record<string, number>>({});
  const [syncError, setSyncError] = useState<string | null>(null);
  const [generatingKey, setGeneratingKey] = useState<string | null>(null);

  const loadTickets = useCallback(
    async (pageNum: number, query: string) => {
      try {
        const data = await listJiraTickets(projectId, {
          limit: PAGE_SIZE,
          offset: pageNum * PAGE_SIZE,
          search: query || undefined,
        });
        setTickets(data.list);
        setTotal(data.total);
      } catch {
        /* ignore */
      }
    },
    [projectId]
  );

  useEffect(() => {
    (async () => {
      const me = await authMe();
      if (!me) {
        router.replace("/login");
        return;
      }
      const status = await getJiraStatus(projectId).catch(() => ({ connected: false }) as JiraConnection);
      setJiraStatus(status);
      await loadTickets(0, "");
      const jiraKeysRes = await listLinkedJiraKeys(projectId).catch(() => ({ keys: [], counts: {} }));
      setLinkedJiraKeys(new Set(jiraKeysRes.keys));
      setJiraKeyCounts(jiraKeysRes.counts ?? {});
      setLoading(false);
    })();
  }, [projectId, loadTickets, router]);

  useEffect(() => {
    if (!loading) loadTickets(page, search);
  }, [page, search, loadTickets, loading]);

  async function handleSync() {
    setSyncing(true);
    setSyncError(null);
    try {
      await syncJiraTickets(projectId);
      await loadTickets(page, search);
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : "Failed to sync Jira tickets.");
    } finally {
      setSyncing(false);
    }
  }

  async function handleGenerateFromTicket(ticket: JiraTicket, mode: "generate" | "regenerate") {
    setGeneratingKey(ticket.jiraIssueKey);
    setSyncError(null);
    try {
      const existingCount = jiraKeyCounts[ticket.jiraIssueKey] || 0;
      const story = `${ticket.jiraIssueKey}: ${ticket.summary}`;
      const context = [
        ticket.description,
        ticket.status ? `Status: ${ticket.status}` : "",
        ticket.priority ? `Priority: ${ticket.priority}` : "",
        mode === "regenerate"
          ? `Regenerate testcase coverage for ${ticket.jiraIssueKey}. Update existing linked testcases where coverage overlaps, and add new testcases for new or changed Jira requirements. Mark regenerated cases clearly with Zyra/Jira tags. Existing linked testcase count: ${existingCount}.`
          : `Generate testcase coverage for ${ticket.jiraIssueKey}. Mark generated cases clearly with Zyra/Jira tags.`
      ].filter(Boolean).join("\n\n");
      await createZyraTask(projectId, {
        story,
        context,
        jiraIssueKeys: [ticket.jiraIssueKey],
      });
      router.push(`/projects/${projectId}/agents/tasks`);
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : "Failed to create Zyra task from Jira ticket.");
    } finally {
      setGeneratingKey(null);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (loading) {
    return (
      <div className="py-12 text-center">
        <p className="text-[var(--muted)]">Loading…</p>
      </div>
    );
  }

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Requirements"
          subtitle="Requirements to be developed, synced from Jira (and future integrations) and turned into test coverage with Zyra. Full documents live in the Knowledge base's Requirements folder."
        />
      }
    >
      {jiraStatus?.connected && (
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              onClick={handleSync}
              disabled={syncing}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--surface-tertiary)] text-[var(--foreground)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--surface-tertiary)] disabled:opacity-50 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {syncing ? "Syncing…" : "Sync Jira"}
            </button>
            <Link
              href={`/projects/${projectId}/settings/integrations/jira`}
              className="inline-flex items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm font-semibold text-[var(--foreground)] shadow-sm transition-colors hover:bg-[var(--surface-secondary)]"
            >
              Manage
            </Link>
            <Link
              href={`/projects/${projectId}/knowledge-base`}
              className="inline-flex items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm font-semibold text-[var(--foreground)] shadow-sm transition-colors hover:bg-[var(--surface-secondary)]"
            >
              View in Knowledge base
            </Link>
          </div>
          <span className="text-sm text-[var(--muted)]">
            {total} requirement{total !== 1 ? "s" : ""}
          </span>
        </div>
      )}

      {syncError && (
        <div className="flex items-center justify-between rounded-lg border border-[var(--error)]/30 bg-[var(--error-soft)] px-4 py-2.5 text-sm text-[var(--error)]">
          <span>{syncError}</span>
          <button type="button" onClick={() => setSyncError(null)} className="ml-3 text-[var(--error)] hover:opacity-80">
            Dismiss
          </button>
        </div>
      )}

      {!jiraStatus?.connected && tickets.length === 0 && (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-12 text-center">
          <div className="mx-auto w-14 h-14 rounded-full bg-[var(--brand-soft)] flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="w-7 h-7 text-[var(--brand-primary)]" fill="currentColor">
              <path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84H11.53ZM6.77 6.8a4.362 4.362 0 0 0 4.34 4.34h1.8v1.72a4.362 4.362 0 0 0 4.34 4.34V7.63a.84.84 0 0 0-.84-.84H6.77ZM2 11.6c0 2.4 1.95 4.34 4.35 4.35h1.78v1.71c0 2.4 1.95 4.35 4.35 4.35V12.44a.84.84 0 0 0-.84-.84H2Z" />
            </svg>
          </div>
          <h2 className="mt-4 text-lg font-semibold text-[var(--foreground)]">
            Connect Jira to Get Started
          </h2>
          <p className="mt-2 text-sm text-[var(--muted)] max-w-sm mx-auto">
            Link your Jira account to automatically import tickets as requirements and use them as context for generating test cases.
          </p>
          <Link
            href={`/projects/${projectId}/settings?tab=integrations`}
            style={{ color: "#fff" }}
            className="mt-4 inline-flex items-center justify-center rounded-lg bg-[var(--brand-primary)] px-5 py-2 text-sm font-semibold !text-white shadow-sm transition-colors hover:bg-[var(--brand-hover)]"
          >
            Go to Project Settings
          </Link>
        </div>
      )}

      {jiraStatus?.connected && tickets.length === 0 && !search && (
        <div className="rounded-xl border border-dashed border-[var(--border)] p-12 text-center">
          <h2 className="text-lg font-semibold text-[var(--foreground)]">No Requirements Synced Yet</h2>
          <p className="mt-2 text-sm text-[var(--muted)] max-w-sm mx-auto">
            Click &quot;Sync Jira&quot; to pull tickets from your connected projects.
          </p>
          <div className="mt-4 flex items-center justify-center gap-3">
            <button
              onClick={handleSync}
              disabled={syncing}
              className="rounded-lg bg-[var(--brand-primary)] text-white px-5 py-2 text-sm font-medium hover:bg-[var(--brand-hover)] disabled:opacity-50 transition-colors"
            >
              {syncing ? "Syncing…" : "Sync Jira Tickets"}
            </button>
            <Link
              href={`/projects/${projectId}/settings/integrations/jira`}
              className="inline-flex items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold text-[var(--foreground)] shadow-sm transition-colors hover:bg-[var(--surface-secondary)]"
            >
              Manage Jira Projects
            </Link>
          </div>
        </div>
      )}

      {(tickets.length > 0 || search) && (
        <>
          <SearchBar
            value={searchInput}
            onChange={setSearchInput}
            onSearch={() => {
              setPage(0);
              setSearch(searchInput);
            }}
            placeholder="Search requirements by key or summary…"
          />

          {search && (
            <div className="text-sm text-[var(--muted)]">
              Showing results for &quot;{search}&quot;
              <button
                onClick={() => {
                  setSearch("");
                  setSearchInput("");
                  setPage(0);
                }}
                className="ml-2 text-[var(--brand-primary)] hover:underline"
              >
                Clear
              </button>
            </div>
          )}

          <div className="flex items-center justify-between text-sm text-[var(--muted)]">
            <span>
              {total} requirement{total !== 1 ? "s" : ""}
              {search && <> matching &quot;{search}&quot;</>}
            </span>
            <span>
              Page {page + 1} of {totalPages}
            </span>
          </div>

          <div className="rounded-xl border border-[var(--border)] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[var(--surface-secondary)] border-b border-[var(--border)]">
                  <th className="text-left px-4 py-2.5 font-medium text-[var(--muted-soft)] w-28">Key</th>
                  <th className="text-left px-4 py-2.5 font-medium text-[var(--muted-soft)]">Summary</th>
                  <th className="text-left px-4 py-2.5 font-medium text-[var(--muted-soft)] w-24">Type</th>
                  <th className="text-left px-4 py-2.5 font-medium text-[var(--muted-soft)] w-28">Status</th>
                  <th className="text-left px-4 py-2.5 font-medium text-[var(--muted-soft)] w-20">Priority</th>
                  <th className="text-left px-4 py-2.5 font-medium text-[var(--muted-soft)] w-32">Assignee</th>
                  <th className="text-right px-4 py-2.5 font-medium text-[var(--muted-soft)] w-52">Action</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((ticket) => (
                  <React.Fragment key={ticket.id}>
                    <tr
                      onClick={() => setExpandedId(expandedId === ticket.id ? null : ticket.id)}
                      className="border-b border-[var(--border-subtle)] hover:bg-[var(--surface-secondary)]/30 cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-2.5">
                        <a
                          href={ticket.jiraUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="font-mono text-xs text-[var(--brand-primary)] hover:underline"
                        >
                          {ticket.jiraIssueKey}
                        </a>
                      </td>
                      <td className="px-4 py-2.5 text-[var(--foreground)] truncate max-w-xs">
                        {ticket.summary}
                      </td>
                      <td className="px-4 py-2.5">
                        <IssueTypeIcon type={ticket.issueType} />
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusChip tone={jiraStatusTone(ticket.status)}>{ticket.status}</StatusChip>
                      </td>
                      <td className="px-4 py-2.5">
                        <PriorityIcon priority={ticket.priority} />
                      </td>
                      <td className="px-4 py-2.5 text-[var(--muted-soft)] text-xs truncate">
                        {ticket.assignee || "Unassigned"}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="inline-flex items-center gap-2">
                          {linkedJiraKeys.has(ticket.jiraIssueKey) && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--success-soft)] px-2 py-0.5 text-xs font-medium text-[var(--success)]">
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                              {jiraKeyCounts[ticket.jiraIssueKey] || 0} saved
                            </span>
                          )}
                          {linkedJiraKeys.has(ticket.jiraIssueKey) ? (
                            <>
                              <Link
                                href={`/projects/${projectId}/testcases?jiraIssueKey=${encodeURIComponent(ticket.jiraIssueKey)}`}
                                onClick={(e) => e.stopPropagation()}
                                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs font-semibold text-[var(--foreground)] shadow-sm hover:bg-[var(--surface-secondary)]"
                              >
                                View testcases
                              </Link>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleGenerateFromTicket(ticket, "regenerate");
                                }}
                                disabled={generatingKey === ticket.jiraIssueKey}
                                className="rounded-lg bg-[var(--brand-primary)] px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-[var(--brand-hover)] disabled:opacity-50"
                              >
                                {generatingKey === ticket.jiraIssueKey ? "Assigning..." : "Regenerate with Zyra"}
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleGenerateFromTicket(ticket, "generate");
                              }}
                              disabled={generatingKey === ticket.jiraIssueKey}
                              className="rounded-lg bg-[var(--brand-primary)] px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-[var(--brand-hover)] disabled:opacity-50"
                            >
                              {generatingKey === ticket.jiraIssueKey ? "Assigning..." : "Assign to Zyra"}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {expandedId === ticket.id && (
                      <tr key={`${ticket.id}-detail`} className="bg-[var(--surface-secondary)]/20">
                        <td colSpan={7} className="px-4 py-4">
                          <div className="space-y-3">
                            {ticket.description && (
                              <div>
                                <h4 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wide mb-1">
                                  Description
                                </h4>
                                <p className="text-sm text-[var(--muted)] whitespace-pre-wrap max-h-48 overflow-y-auto">
                                  {ticket.description}
                                </p>
                              </div>
                            )}
                            <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-[var(--muted)]">
                              {ticket.reporter && (
                                <span>Reporter: <span className="text-[var(--muted)]">{ticket.reporter}</span></span>
                              )}
                              {ticket.labels && (
                                <span>Labels: <span className="text-[var(--muted)]">{ticket.labels}</span></span>
                              )}
                              {ticket.jiraCreatedAt && (
                                <span>Created: <span className="text-[var(--muted)]">{new Date(ticket.jiraCreatedAt).toLocaleDateString()}</span></span>
                              )}
                              {ticket.jiraUpdatedAt && (
                                <span>Updated: <span className="text-[var(--muted)]">{new Date(ticket.jiraUpdatedAt).toLocaleDateString()}</span></span>
                              )}
                            </div>
                            <a
                              href={ticket.jiraUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-block text-xs text-[var(--brand-primary)] hover:underline"
                            >
                              Open in Jira →
                            </a>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm font-medium text-[var(--muted)] hover:bg-[var(--surface-secondary)] disabled:opacity-40 transition-colors"
              >
                Previous
              </button>
              <span className="text-sm text-[var(--muted)]">
                {page + 1} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm font-medium text-[var(--muted)] hover:bg-[var(--surface-secondary)] disabled:opacity-40 transition-colors"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </StandardPageLayout>
  );
}
