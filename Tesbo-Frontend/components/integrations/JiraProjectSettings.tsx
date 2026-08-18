"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { getProject, updateProject } from "@/lib/api";
import { Button, Card } from "@/components/ui";

type ProjectSettingsPayload = {
  jiraAutoComment?: boolean;
  jiraTicketSelector?: boolean;
  [key: string]: unknown;
};

function parseProjectSettings(raw: unknown): ProjectSettingsPayload {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as ProjectSettingsPayload;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as ProjectSettingsPayload;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Jira-only project settings, shown on the Jira integration page.
 *
 * These used to be their own "Jira" tab in the project settings nav rail; they live here so every
 * integration keeps its settings on its own page instead of leaking a tab into the rail. Loads and
 * saves the project's `settings` blob on its own — the surrounding mapping screen owns no state here.
 */
export function JiraProjectSettings() {
  const params = useParams();
  const projectId = params.id as string;

  const [rawSettings, setRawSettings] = useState<unknown>(null);
  const [autoComment, setAutoComment] = useState(false);
  const [ticketSelector, setTicketSelector] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const project = await getProject(projectId);
      const settings = parseProjectSettings(project.settings);
      setRawSettings(project.settings);
      setAutoComment(settings.jiraAutoComment === true);
      setTicketSelector(settings.jiraTicketSelector === true);
    } catch {
      setMessage({ type: "error", text: "Failed to load Jira settings." });
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      const nextSettings: ProjectSettingsPayload = {
        ...parseProjectSettings(rawSettings),
        jiraAutoComment: autoComment,
        jiraTicketSelector: ticketSelector,
      };
      await updateProject(projectId, { settings: JSON.stringify(nextSettings) });
      const refreshed = await getProject(projectId);
      setRawSettings(refreshed.settings);
      setMessage({ type: "success", text: "Jira settings saved." });
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : "Failed to save Jira settings." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-4 space-y-4">
      <div>
        <h2 className="text-base font-semibold text-[var(--foreground)]">Jira + AI Generation</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Control how Jira tickets interact with AI test generation in this project.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-[var(--muted)]">Loading…</p>
      ) : (
        <>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={autoComment}
              onChange={(e) => setAutoComment(e.target.checked)}
              className="mt-0.5"
            />
            <div>
              <span className="text-sm font-medium text-[var(--foreground)]">Auto-comment on Jira ticket</span>
              <p className="text-xs text-[var(--muted)] mt-0.5">
                When test cases are generated from a Jira ticket and saved, automatically add a comment to the Jira ticket listing the created test cases.
              </p>
            </div>
          </label>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={ticketSelector}
              onChange={(e) => setTicketSelector(e.target.checked)}
              className="mt-0.5"
            />
            <div>
              <span className="text-sm font-medium text-[var(--foreground)]">Jira ticket selector on AI Generation</span>
              <p className="text-xs text-[var(--muted)] mt-0.5">
                Show a Jira ticket search dropdown on the AI Test Generation page so users can pick a ticket directly without going through the Knowledge Base.
              </p>
            </div>
          </label>

          {message && (
            <p
              className={`rounded-lg border px-3 py-2 text-sm ${
                message.type === "success"
                  ? "border-[var(--success)]/30 bg-[color-mix(in_oklab,var(--success)_8%,white)] text-[var(--success-foreground)]"
                  : "border-[var(--error)]/30 bg-[color-mix(in_oklab,var(--error)_8%,white)] text-[var(--error-foreground)]"
              }`}
            >
              {message.text}
            </p>
          )}

          <Button type="button" onClick={() => void handleSave()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      )}
    </Card>
  );
}
