"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { authMe } from "@/lib/api";
import { Button, Card } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

interface RemoteItem {
  id: string;
  key: string;
  name: string;
  connected: boolean;
}

interface ConnectionStatus {
  connected: boolean;
  siteUrl?: string;
  connectedProjects?: { id: string }[];
}

export function ProjectIntegrationMapping({
  label,
  remoteUnitLabel,
  workspaceConfigHref,
  fetchStatus,
  fetchRemoteList,
  saveMapping,
  sync,
}: {
  label: string;
  remoteUnitLabel: string;
  workspaceConfigHref: string;
  fetchStatus: (projectId: string) => Promise<ConnectionStatus>;
  fetchRemoteList: (projectId: string) => Promise<RemoteItem[]>;
  saveMapping: (projectId: string, items: { id: string; key: string; name: string }[]) => Promise<void>;
  sync: (projectId: string) => Promise<{ synced: number }>;
}) {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [remoteItems, setRemoteItems] = useState<RemoteItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [itemsLoading, setItemsLoading] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const me = await authMe();
      if (!me) {
        router.replace("/login");
        return;
      }
      const statusRes = await fetchStatus(projectId);
      setStatus(statusRes);

      if (statusRes.connected) {
        setItemsLoading(true);
        const items = await fetchRemoteList(projectId);
        setRemoteItems(items);
        setSelected(new Set(items.filter((item) => item.connected).map((item) => item.id)));
        setItemsLoading(false);
      }
    } catch {
      setMessage({ type: "error", text: `Failed to load ${label} integration data.` });
    } finally {
      setLoading(false);
    }
  }, [projectId, router, fetchStatus, fetchRemoteList, label]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function toggleItem(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSaveMapping() {
    setSaving(true);
    setMessage(null);
    try {
      const items = remoteItems
        .filter((item) => selected.has(item.id))
        .map((item) => ({ id: item.id, key: item.key, name: item.name }));
      await saveMapping(projectId, items);
      setMessage({ type: "success", text: `${remoteUnitLabel} mapping saved.` });
      setStatus(await fetchStatus(projectId));
    } catch {
      setMessage({ type: "error", text: `Failed to save ${remoteUnitLabel} mapping.` });
    } finally {
      setSaving(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setMessage(null);
    try {
      const result = await sync(projectId);
      setMessage({ type: "success", text: `Synced ${result.synced} tickets from ${label}.` });
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : `Failed to sync ${label} tickets.` });
    } finally {
      setSyncing(false);
    }
  }

  const breadcrumb = (
    <Link href={`/projects/${projectId}/settings?tab=integrations`} className="text-[var(--brand-primary)] hover:underline">
      &larr; Back to Project Settings
    </Link>
  );

  if (loading) {
    return (
      <StandardPageLayout header={<PageHeader title={`${label} Integration`} />}>
        <div className="flex min-h-[200px] items-center justify-center">
          <p className="text-[var(--muted)]">Loading…</p>
        </div>
      </StandardPageLayout>
    );
  }

  if (!status?.connected) {
    return (
      <StandardPageLayout header={<PageHeader title={`${label} Integration`} breadcrumb={breadcrumb} />}>
        {message && (
          <div className="rounded-lg border border-[var(--error)]/30 bg-[color-mix(in_oklab,var(--error)_8%,white)] px-3 py-2 text-sm text-[var(--error)]">
            {message.text}
          </div>
        )}
        <Card className="p-4">
          <h2 className="text-base font-semibold text-[var(--foreground)]">{label} is not connected for this workspace</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Ask a workspace owner to connect {label} once for the whole workspace, then come back here to pick which {remoteUnitLabel.toLowerCase()} feeds this project.
          </p>
          <Link
            href={workspaceConfigHref}
            className="mt-4 inline-flex h-9 items-center justify-center rounded-[10px] border border-transparent bg-[var(--brand-primary)] px-3.5 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-[var(--brand-hover)]"
          >
            Go to Workspace Settings → Integrations
          </Link>
        </Card>
      </StandardPageLayout>
    );
  }

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title={`${label} Integration`}
          subtitle={
            status.siteUrl ? (
              <>
                Connected to{" "}
                <a href={status.siteUrl} target="_blank" rel="noopener noreferrer" className="text-[var(--brand-primary)] hover:underline">
                  {status.siteUrl}
                </a>
              </>
            ) : undefined
          }
          breadcrumb={breadcrumb}
        />
      }
    >
      {message && (
        <div
          className={`rounded-lg border px-3 py-2 text-sm ${
            message.type === "success"
              ? "border-[var(--success)]/30 bg-[color-mix(in_oklab,var(--success)_8%,white)] text-[var(--success)]"
              : "border-[var(--error)]/30 bg-[color-mix(in_oklab,var(--error)_8%,white)] text-[var(--error)]"
          }`}
        >
          {message.text}
        </div>
      )}

      <Card className="p-4">
        <h2 className="text-base font-semibold text-[var(--foreground)]">Select {remoteUnitLabel}s</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Choose which {remoteUnitLabel.toLowerCase()}(s) to link. Tickets from selected {remoteUnitLabel.toLowerCase()}s will be available in the Knowledge Base.
        </p>

        {itemsLoading ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-[var(--muted)]">
            <div className="w-4 h-4 rounded-full border-2 border-[var(--brand-primary)] border-t-transparent animate-spin" />
            Loading {remoteUnitLabel.toLowerCase()}s…
          </div>
        ) : remoteItems.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--muted)]">No {remoteUnitLabel.toLowerCase()}s found in your {label} workspace.</p>
        ) : (
          <div className="mt-4 space-y-2 max-h-80 overflow-y-auto">
            {remoteItems.map((item) => (
              <label
                key={item.id}
                className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${
                  selected.has(item.id)
                    ? "border-[var(--brand-primary)] bg-[var(--brand-soft)]"
                    : "border-[var(--border)] hover:bg-[var(--surface-secondary)]"
                }`}
              >
                <input
                  type="checkbox"
                  checked={selected.has(item.id)}
                  onChange={() => toggleItem(item.id)}
                  className="rounded border-[var(--border)] text-[var(--brand-primary)] focus:ring-[var(--brand-soft)]"
                />
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium text-[var(--foreground)]">{item.name}</span>
                  <span className="ml-2 text-xs text-[var(--muted)] font-mono">{item.key}</span>
                </div>
              </label>
            ))}
          </div>
        )}

        <div className="mt-4 flex items-center gap-3">
          <Button onClick={handleSaveMapping} disabled={saving || selected.size === 0}>
            {saving ? "Saving…" : `Link ${selected.size} ${remoteUnitLabel}${selected.size !== 1 ? "s" : ""}`}
          </Button>
          <span className="text-xs text-[var(--muted-soft)]">{selected.size} selected</span>
        </div>
      </Card>

      {status.connectedProjects && status.connectedProjects.length > 0 && (
        <Card className="p-4">
          <h2 className="text-base font-semibold text-[var(--foreground)]">Sync Tickets</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Pull the latest tickets from your linked {remoteUnitLabel.toLowerCase()}s into the Knowledge Base.
          </p>
          <div className="mt-3 flex items-center gap-3">
            <Button variant="secondary" onClick={handleSync} disabled={syncing}>
              {syncing ? "Syncing…" : "Sync Now"}
            </Button>
            <Link href={`/projects/${projectId}/knowledge-base`} className="text-sm text-[var(--brand-primary)] hover:underline">
              View Knowledge Base →
            </Link>
          </div>
        </Card>
      )}
    </StandardPageLayout>
  );
}
