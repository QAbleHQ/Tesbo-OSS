"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  getWorkspace,
  getIntegrationStatus,
  disconnectIntegration,
  type IntegrationConnectionStatus,
  type IntegrationProvider,
} from "@/lib/api";
import { Button, Card } from "@/components/ui";

const PROVIDERS: {
  id: IntegrationProvider;
  name: string;
  description: string;
  icon: React.ReactNode;
}[] = [
  {
    id: "jira",
    name: "Jira",
    description: "Import tickets from Jira to use as knowledge base for test generation.",
    icon: (
      <svg viewBox="0 0 24 24" className="w-6 h-6 text-white" fill="currentColor">
        <path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84H11.53ZM6.77 6.8a4.362 4.362 0 0 0 4.34 4.34h1.8v1.72a4.362 4.362 0 0 0 4.34 4.34V7.63a.84.84 0 0 0-.84-.84H6.77ZM2 11.6c0 2.4 1.95 4.34 4.35 4.35h1.78v1.71c0 2.4 1.95 4.35 4.35 4.35V12.44a.84.84 0 0 0-.84-.84H2Z" />
      </svg>
    ),
  },
  {
    id: "linear",
    name: "Linear",
    description: "Import issues from Linear to use as knowledge base for test generation.",
    icon: (
      <svg viewBox="0 0 24 24" className="w-6 h-6 text-white" fill="currentColor">
        <path d="M2.28 15.36 8.64 21.7c-3.14-.55-5.79-3.2-6.36-6.34Zm-.27-2.06L14.7 22c.34.02.68.02 1.02 0L1.99 8.98c-.02.34-.02.68.02 1.02Zm.5-3.14L15.84 21.5a10.9 10.9 0 0 0 1.87-1.1L3.6 6.29a10.9 10.9 0 0 0-1.09 1.87Zm1.9-2.98L18.82 18.5a11 11 0 0 0 1.28-1.55L5.06 5.9a11 11 0 0 0-1.55 1.28Zm2.71-2.2L21.02 15.87A11 11 0 0 0 22 1.98L8.12 1a11 11 0 0 0-1.9 1.98Z" />
      </svg>
    ),
  },
];

export default function IntegrationsTab() {
  const [workspaceRole, setWorkspaceRole] = useState<string>("member");
  const [statuses, setStatuses] = useState<Record<string, IntegrationConnectionStatus>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [disconnectingProvider, setDisconnectingProvider] = useState<IntegrationProvider | null>(null);

  const canManage = workspaceRole === "owner";

  const loadData = useCallback(async () => {
    try {
      const [workspace, jira, linear] = await Promise.all([
        getWorkspace(),
        getIntegrationStatus("jira").catch(() => ({ connected: false }) as IntegrationConnectionStatus),
        getIntegrationStatus("linear").catch(() => ({ connected: false }) as IntegrationConnectionStatus),
      ]);
      setWorkspaceRole((workspace.role || "member").toLowerCase());
      setStatuses({ jira, linear });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load integrations.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadData(); }, [loadData]);

  async function handleDisconnect(provider: IntegrationProvider) {
    if (!canManage) return;
    setDisconnectingProvider(provider);
    setMessage(null);
    setError(null);
    try {
      await disconnectIntegration(provider);
      setMessage(`${provider === "jira" ? "Jira" : "Linear"} disconnected.`);
      await loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to disconnect.");
    } finally {
      setDisconnectingProvider(null);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[200px] items-center justify-center">
        <p className="text-[var(--muted)]">Loading…</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-[var(--foreground)]">Integrations</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Connect Jira, Linear, and more once for the whole workspace, then pick which projects use them.
        </p>
      </div>

      {message && (
        <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2 text-sm text-[var(--foreground)]">
          {message}
        </p>
      )}
      {error && (
        <p className="rounded-lg border border-[var(--error)]/40 bg-[color-mix(in_oklab,var(--error)_8%,white)] px-3 py-2 text-sm text-[var(--error)]">
          {error}
        </p>
      )}

      <Card className="p-4 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-[var(--foreground)]">App integrations</h3>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Once connected, go to a project&apos;s Settings → Integrations tab to pick which remote project/team feeds it.
          </p>
        </div>

        {PROVIDERS.map((provider) => {
          const status = statuses[provider.id];
          return (
            <div key={provider.id} className="rounded-lg border border-[var(--border)] p-4 flex items-start gap-4">
              <div className="shrink-0 w-10 h-10 rounded-lg bg-[var(--brand-primary)] flex items-center justify-center">
                {provider.icon}
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold text-[var(--foreground)]">{provider.name}</h3>
                <p className="text-xs text-[var(--muted)] mt-0.5">{provider.description}</p>
                {status?.connected && (
                  <div className="mt-2 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="inline-block w-2 h-2 rounded-full bg-[var(--success)]" />
                      <span className="text-xs text-[var(--success)] font-medium">Connected</span>
                      {status.siteUrl && (
                        <>
                          <span className="text-xs text-[var(--muted-soft)]">·</span>
                          <a
                            href={status.siteUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-[var(--brand-primary)] hover:underline truncate"
                          >
                            {status.siteUrl}
                          </a>
                        </>
                      )}
                    </div>
                    {status.connectedProjects && status.connectedProjects.length > 0 && (
                      <p className="text-xs text-[var(--muted)]">
                        Used by {status.connectedProjects.length} project{status.connectedProjects.length > 1 ? "s" : ""}:{" "}
                        {status.connectedProjects.map((p) => p.projectKey).join(", ")}
                      </p>
                    )}
                  </div>
                )}
              </div>
              <div className="shrink-0 flex flex-col gap-2">
                {status?.connected ? (
                  <>
                    <Link
                      href={`/settings/integrations/${provider.id}`}
                      className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)] transition-colors text-center"
                    >
                      Manage
                    </Link>
                    {canManage && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => void handleDisconnect(provider.id)}
                        disabled={disconnectingProvider === provider.id}
                        className="border-[var(--error)]/50 text-[var(--error)] hover:bg-[color-mix(in_oklab,var(--error)_8%,white)]"
                      >
                        Disconnect
                      </Button>
                    )}
                  </>
                ) : (
                  <Link
                    href={`/settings/integrations/${provider.id}`}
                    className="inline-flex h-9 items-center justify-center rounded-[10px] border border-transparent bg-[var(--brand-primary)] px-3.5 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-[var(--brand-hover)]"
                  >
                    Configure
                  </Link>
                )}
              </div>
            </div>
          );
        })}

        {!canManage && (
          <p className="text-xs text-[var(--muted)]">Only the workspace owner can connect or disconnect integrations.</p>
        )}

        {/* Placeholder for future integrations */}
        <div className="rounded-lg border border-dashed border-[var(--border)] p-4 flex items-center gap-4 opacity-60">
          <div className="shrink-0 w-10 h-10 rounded-lg bg-[var(--surface-tertiary)] flex items-center justify-center">
            <svg className="w-5 h-5 text-[var(--muted-soft)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-medium text-[var(--muted)]">More integrations coming soon</h3>
            <p className="text-xs text-[var(--muted-soft)] mt-0.5">Slack, GitHub, Azure DevOps and more.</p>
          </div>
        </div>
      </Card>
    </div>
  );
}
