"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  authMe,
  getWorkspace,
  getIntegrationConfig,
  getIntegrationStatus,
  getIntegrationAuthUrl,
  updateIntegrationConfig,
  disconnectIntegration,
  type IntegrationOAuthConfig,
  type IntegrationConnectionStatus,
  type IntegrationProvider,
} from "@/lib/api";
import { Button, Card, Field, FieldLabel, Input } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

export function WorkspaceIntegrationConfig({
  provider,
  label,
  consoleName,
  consoleSteps,
  scopes,
}: {
  provider: IntegrationProvider;
  label: string;
  consoleName: string;
  consoleSteps: string[];
  scopes: string[];
}) {
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [canManage, setCanManage] = useState(false);
  const [status, setStatus] = useState<IntegrationConnectionStatus | null>(null);
  const [config, setConfig] = useState<IntegrationOAuthConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState("");

  const loadData = useCallback(async () => {
    try {
      const [workspace, statusRes, configRes] = await Promise.all([
        getWorkspace(),
        getIntegrationStatus(provider),
        getIntegrationConfig(provider).catch(() => null),
      ]);
      setCanManage((workspace.role || "member").toLowerCase() === "owner");
      setStatus(statusRes);
      setConfig(configRes);
      if (configRes) {
        setClientId(configRes.clientId || "");
        setRedirectUri(configRes.redirectUri || "");
      }
    } catch {
      setMessage({ type: "error", text: `Failed to load ${label} integration data.` });
    } finally {
      setLoading(false);
    }
  }, [provider, label]);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      void loadData();
    });
  }, [loadData, router]);

  async function handleSaveConfig(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const next = await updateIntegrationConfig(provider, {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        redirectUri: redirectUri.trim(),
      });
      setConfig(next);
      setClientSecret("");
      setMessage({ type: "success", text: `${label} configuration saved. You can connect ${label} now.` });
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : `Failed to save ${label} configuration.` });
    } finally {
      setSaving(false);
    }
  }

  async function handleConnect() {
    setConnecting(true);
    setMessage(null);
    try {
      const { url } = await getIntegrationAuthUrl(provider);
      window.location.href = url;
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : `Failed to initiate ${label} authentication.` });
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    setMessage(null);
    try {
      await disconnectIntegration(provider);
      await loadData();
      setMessage({ type: "success", text: `${label} disconnected.` });
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : `Failed to disconnect ${label}.` });
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return (
      <StandardPageLayout header={<PageHeader title={`${label} Integration`} />}>
        <div className="flex min-h-[200px] items-center justify-center">
          <p className="text-[var(--muted)]">Loading…</p>
        </div>
      </StandardPageLayout>
    );
  }

  const breadcrumb = (
    <Link href="/settings/integrations" className="text-[var(--brand-primary)] hover:underline">
      &larr; Back to Integrations
    </Link>
  );

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title={`${label} Integration`}
          subtitle={
            status?.connected && status.siteUrl ? (
              <>
                Connected to{" "}
                <a href={status.siteUrl} target="_blank" rel="noopener noreferrer" className="text-[var(--brand-primary)] hover:underline">
                  {status.siteUrl}
                </a>
              </>
            ) : (
              `Connect ${label} once for this workspace, then map remote projects to Tesbo projects from each project's Settings → Integrations tab.`
            )
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

      {!canManage && (
        <Card className="p-4">
          <p className="text-sm text-[var(--muted)]">Only the workspace owner can configure or connect {label}.</p>
        </Card>
      )}

      {status?.connected ? (
        <Card className="p-4 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--foreground)]">Connected</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              {status.connectedProjects && status.connectedProjects.length > 0
                ? `${status.connectedProjects.length} project(s) currently map to this ${label} connection.`
                : `No Tesbo project is mapped to this ${label} connection yet.`}
            </p>
          </div>
          {status.connectedProjects && status.connectedProjects.length > 0 && (
            <ul className="space-y-1 text-sm text-[var(--foreground)]">
              {status.connectedProjects.map((p) => (
                <li key={p.projectId} className="flex items-center gap-2">
                  <span className="font-mono text-xs text-[var(--muted)]">{p.projectKey}</span>
                  <span>{p.projectName}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-sm text-[var(--muted)]">
            To pick which {provider === "jira" ? "Jira project" : "Linear team"} feeds a Tesbo project, open that project&apos;s Settings → Integrations tab.
          </p>
          {canManage && (
            <Button
              type="button"
              variant="secondary"
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="border-[var(--error)]/50 text-[var(--error)] hover:bg-[color-mix(in_oklab,var(--error)_8%,white)]"
            >
              {disconnecting ? "Disconnecting..." : `Disconnect ${label}`}
            </Button>
          )}
        </Card>
      ) : (
        canManage && (
          <Card className="p-4">
            <h2 className="text-base font-semibold text-[var(--foreground)]">Configure {label} OAuth</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Add the OAuth app values from the {consoleName}. These values apply to this entire workspace.
            </p>

            <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3 text-sm text-[var(--foreground)]">
              <p className="font-medium">In the {consoleName}:</p>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-[var(--muted)]">
                {consoleSteps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
                <li>
                  Enable scopes: {scopes.map((scope, i) => (
                    <span key={scope}>
                      <span className="font-mono text-[var(--foreground)]">{scope}</span>
                      {i < scopes.length - 1 ? ", " : ""}
                    </span>
                  ))}.
                </li>
                <li>Copy the Client ID and Client Secret into the form below.</li>
              </ol>
            </div>

            <form onSubmit={handleSaveConfig} className="mt-4 space-y-4">
              <Field>
                <FieldLabel>Authorization callback URL</FieldLabel>
                <Input
                  type="url"
                  value={redirectUri}
                  onChange={(event) => setRedirectUri(event.target.value)}
                  placeholder="http://localhost:1010/integrations/callback"
                />
                <p className="mt-1 text-xs text-[var(--muted)]">
                  Paste this exact value into the {consoleName}. For this app, the callback page is <span className="font-mono text-[var(--foreground)]">/integrations/callback</span>.
                </p>
              </Field>
              <Field>
                <FieldLabel>Client ID</FieldLabel>
                <Input
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                  placeholder={`Paste ${label} OAuth client ID`}
                />
              </Field>
              <Field>
                <FieldLabel>Client Secret</FieldLabel>
                <Input
                  type="password"
                  value={clientSecret}
                  onChange={(event) => setClientSecret(event.target.value)}
                  placeholder={config?.hasClientSecret ? "Saved. Enter a new secret only to replace it." : `Paste ${label} OAuth client secret`}
                />
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" disabled={saving}>
                  {saving ? "Saving..." : `Save ${label} Configuration`}
                </Button>
                <Button type="button" variant="secondary" onClick={handleConnect} disabled={connecting || !config?.configured}>
                  {connecting ? "Connecting..." : `Connect ${label}`}
                </Button>
                {config?.configured && (
                  <span className="text-xs text-[var(--success)]">
                    Configuration saved from {config.source === "environment" ? "environment variables" : "workspace settings"}.
                  </span>
                )}
              </div>
            </form>
          </Card>
        )
      )}
    </StandardPageLayout>
  );
}
