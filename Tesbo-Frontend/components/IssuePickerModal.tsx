"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getJiraStatus,
  getLinearStatus,
  searchJiraIssuesLive,
  searchLinearIssuesLive,
  type IssueSearchResult,
} from "@/lib/api";
import { Button, Field, FieldLabel, Input, Modal } from "@/components/ui";

interface Props {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onSelect: (issue: IssueSearchResult) => void;
}

export default function IssuePickerModal({ projectId, open, onClose, onSelect }: Props) {
  const [provider, setProvider] = useState<"JIRA" | "LINEAR" | null>(null);
  const [available, setAvailable] = useState<{ jira: boolean; linear: boolean }>({ jira: false, linear: false });
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<IssueSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setResults([]);
    setError(null);
    (async () => {
      const [jira, linear] = await Promise.all([
        getJiraStatus(projectId).catch(() => ({ connected: false })),
        getLinearStatus(projectId).catch(() => ({ connected: false })),
      ]);
      setAvailable({ jira: jira.connected, linear: linear.connected });
      setProvider(jira.connected ? "JIRA" : linear.connected ? "LINEAR" : null);
    })();
  }, [open, projectId]);

  const runSearch = useCallback(async (term: string) => {
    if (!provider) return;
    setLoading(true);
    setError(null);
    try {
      const { list } = provider === "JIRA"
        ? await searchJiraIssuesLive(projectId, term)
        : await searchLinearIssuesLive(projectId, term);
      setResults(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
    } finally {
      setLoading(false);
    }
  }, [provider, projectId]);

  useEffect(() => {
    if (!open || !provider) return;
    const handle = setTimeout(() => runSearch(search), 300);
    return () => clearTimeout(handle);
  }, [open, provider, search, runSearch]);

  if (!open) return null;

  return (
    <Modal open={open} onClose={onClose} title="Link a ticket" className="max-w-[520px]">
      {!available.jira && !available.linear ? (
        <p className="text-[14px] text-[var(--muted)]">
          No issue tracker is connected for this project. Connect Jira or Linear in project settings to search tickets here.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="flex gap-2">
            {available.jira ? (
              <Button type="button" size="sm" variant={provider === "JIRA" ? "primary" : "secondary"} onClick={() => setProvider("JIRA")}>
                Jira
              </Button>
            ) : null}
            {available.linear ? (
              <Button type="button" size="sm" variant={provider === "LINEAR" ? "primary" : "secondary"} onClick={() => setProvider("LINEAR")}>
                Linear
              </Button>
            ) : null}
          </div>

          <Field>
            <FieldLabel>Search issues</FieldLabel>
            <Input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by key or summary…" />
          </Field>

          {error ? <p className="text-[13px] text-[var(--error)]">{error}</p> : null}

          <div className="max-h-[320px] overflow-y-auto rounded-[var(--radius-control)] border border-[var(--border)]">
            {loading ? (
              <p className="p-3 text-[13px] text-[var(--muted)]">Searching…</p>
            ) : results.length === 0 ? (
              <p className="p-3 text-[13px] text-[var(--muted)]">No issues found.</p>
            ) : (
              results.map((issue) => (
                <button
                  key={`${issue.provider}-${issue.key}`}
                  type="button"
                  onClick={() => onSelect(issue)}
                  className="flex w-full flex-col items-start gap-0.5 border-b border-[var(--border)] px-3 py-2 text-left last:border-b-0 hover:bg-[var(--surface-secondary)]"
                >
                  <span className="text-[13px] font-medium text-[var(--foreground)]">{issue.key} — {issue.summary}</span>
                  <span className="text-[12px] text-[var(--muted)]">{issue.status}</span>
                </button>
              ))
            )}
          </div>

          <div className="flex justify-end">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
