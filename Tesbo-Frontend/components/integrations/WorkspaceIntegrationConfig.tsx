"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import {
  authMe,
  getWorkspace,
  getIntegrationConfig,
  getIntegrationStatus,
  getIntegrationAuthUrl,
  updateIntegrationConfig,
  connectIntegrationToken,
  disconnectIntegration,
  INTEGRATION_RETURN_PROJECT_KEY,
  type IntegrationOAuthConfig,
  type IntegrationConnectionStatus,
  type IntegrationProvider,
} from "@/lib/api";
import { Button, Card, Field, FieldLabel, Input } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

type PatField = {
  key: "siteUrl" | "email" | "apiToken" | "apiKey";
  label: string;
  type?: "text" | "email" | "password" | "url";
  placeholder?: string;
  help?: string;
};

// Providers that don't support a Personal Access Token yet simply set `null` here — the
// advanced token panel disappears automatically, no other file needs to change.
const PROVIDER_PAT_FIELDS: Record<IntegrationProvider, PatField[] | null> = {
  jira: [
    { key: "siteUrl", label: "Jira site URL", type: "url", placeholder: "https://yourcompany.atlassian.net" },
    { key: "email", label: "Atlassian account email", type: "email", placeholder: "you@yourcompany.com" },
    {
      key: "apiToken",
      label: "API token",
      type: "password",
      placeholder: "Paste your Atlassian API token",
      help: "Create one at id.atlassian.com/manage-profile/security/api-tokens.",
    },
  ],
  linear: [
    {
      key: "apiKey",
      label: "Personal API key",
      type: "password",
      placeholder: "lin_api_...",
      help: "Create one from Linear Settings → Security & access → Personal API keys.",
    },
  ],
};

function isValidProjectId(value: string | null): value is string {
  return !!value && /^[a-zA-Z0-9-]+$/.test(value);
}

function ChevronIcon() {
  return (
    <svg
      className="h-4 w-4 shrink-0 text-[var(--muted)] transition-transform group-open:rotate-180"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function WorkspaceIntegrationConfigInner({
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
  const searchParams = useSearchParams();
  const returnProjectIdParam = searchParams.get("returnProjectId");
  const returnProjectId = isValidProjectId(returnProjectIdParam) ? returnProjectIdParam : null;

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

  const patFields = PROVIDER_PAT_FIELDS[provider];
  const [patValues, setPatValues] = useState<Record<string, string>>({});
  const [connectingToken, setConnectingToken] = useState(false);

  // `source: "environment"` means the backend resolved credentials from Tesbo's platform OAuth app
  // rather than a workspace-saved one, so the owner has nothing to configure — just Connect.
  const platformManaged = config?.source === "environment" && config.configured;

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
      if (returnProjectId) sessionStorage.setItem(INTEGRATION_RETURN_PROJECT_KEY, returnProjectId);
      else sessionStorage.removeItem(INTEGRATION_RETURN_PROJECT_KEY);
      const { url } = await getIntegrationAuthUrl(provider);
      window.location.href = url;
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : `Failed to initiate ${label} authentication.` });
      setConnecting(false);
    }
  }

  async function handleConnectToken(e: FormEvent) {
    e.preventDefault();
    setConnectingToken(true);
    setMessage(null);
    try {
      await connectIntegrationToken(provider, patValues);
      setPatValues({});
      await loadData();
      setMessage({ type: "success", text: `${label} connected.` });
    } catch (err) {
      setMessage({ type: "error", text: err instanceof Error ? err.message : `Failed to connect ${label}.` });
    } finally {
      setConnectingToken(false);
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
    <Link href="/settings?tab=integrations" className="text-[var(--brand-primary)] hover:underline">
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
              Connected via {status.authMethod === "personal_token" ? "Personal Access Token" : "OAuth"}
              {status.authMethod === "personal_token" && status.personalTokenIdentifier ? ` (${status.personalTokenIdentifier})` : ""}.
            </p>
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
          <div className="space-y-4">
            <Card className="p-4 space-y-3">
              <div>
                <h2 className="text-base font-semibold text-[var(--foreground)]">Connect {label}</h2>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  {platformManaged
                    ? `Sign in with ${label} and approve access — Tesbo handles the OAuth app, so there's nothing to set up.`
                    : config?.configured
                      ? `Sign in with ${label} and pick which project to link — no manual setup needed.`
                      : `Set up an OAuth app below (or use a Personal Access Token) to enable connecting.`}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" onClick={handleConnect} disabled={connecting || !config?.configured}>
                  {connecting ? `Redirecting to ${label}...` : `Connect ${label}`}
                </Button>
                {config?.configured && !platformManaged && (
                  <span className="text-xs text-[var(--success)]">Ready via your saved OAuth app.</span>
                )}
              </div>
              {platformManaged && (
                <p className="text-xs text-[var(--muted)]">
                  You&apos;ll be taken to {label} to approve access, then brought back here automatically.
                </p>
              )}
              {returnProjectId && (
                <p className="text-xs text-[var(--muted)]">
                  You&apos;ll be brought straight back to finish mapping your project after connecting.
                </p>
              )}
            </Card>

            {/* Bring-your-own OAuth app. Hidden when Tesbo's platform app is configured — that is
                the whole point of the platform app, and a visible client id/secret form there just
                invites owners to break a working connection. Self-hosted deployments with no
                platform credentials still get the full form. */}
            {!platformManaged && (
              <details className="tesbo-card group p-4" open>
                <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold text-[var(--foreground)]">
                  <span>Advanced: OAuth app settings</span>
                  <ChevronIcon />
                </summary>
                <div className="mt-4">
                  <p className="text-sm text-[var(--muted)]">
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
                    </div>
                  </form>
                </div>
              </details>
            )}

            {patFields && (
              <details className="tesbo-card group p-4">
                <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold text-[var(--foreground)]">
                  <span>Advanced: connect with a Personal Access Token instead</span>
                  <ChevronIcon />
                </summary>
                <div className="mt-4">
                  <p className="text-sm text-[var(--muted)]">
                    No OAuth app required — paste a personal token below to connect this workspace directly.
                  </p>
                  <form onSubmit={handleConnectToken} className="mt-4 space-y-4">
                    {patFields.map((field) => (
                      <Field key={field.key}>
                        <FieldLabel>{field.label}</FieldLabel>
                        <Input
                          type={field.type || "text"}
                          value={patValues[field.key] || ""}
                          onChange={(event) => setPatValues((prev) => ({ ...prev, [field.key]: event.target.value }))}
                          placeholder={field.placeholder}
                        />
                        {field.help && <p className="mt-1 text-xs text-[var(--muted)]">{field.help}</p>}
                      </Field>
                    ))}
                    <Button type="submit" disabled={connectingToken}>
                      {connectingToken ? "Connecting..." : `Connect ${label}`}
                    </Button>
                  </form>
                </div>
              </details>
            )}
          </div>
        )
      )}
    </StandardPageLayout>
  );
}

export function WorkspaceIntegrationConfig(props: {
  provider: IntegrationProvider;
  label: string;
  consoleName: string;
  consoleSteps: string[];
  scopes: string[];
}) {
  return (
    <Suspense
      fallback={
        <StandardPageLayout header={<PageHeader title={`${props.label} Integration`} />}>
          <div className="flex min-h-[200px] items-center justify-center">
            <p className="text-[var(--muted)]">Loading…</p>
          </div>
        </StandardPageLayout>
      }
    >
      <WorkspaceIntegrationConfigInner {...props} />
    </Suspense>
  );
}
