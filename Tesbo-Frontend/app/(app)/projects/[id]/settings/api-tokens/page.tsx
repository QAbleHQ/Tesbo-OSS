"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { IconChevronRight, IconKey } from "@tabler/icons-react";
import {
  authMe,
  listProjectMembers,
  listApiKeys,
  createApiKey,
  revokeApiKey,
  getMcpUrl,
  type ApiToken,
  type ApiTokenWithSecret,
} from "@/lib/api";
import { Button, Card, Modal, Input, Field, FieldLabel, StatusChip, CopyButton } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

type ProjectMember = { userId: string; email: string; name: string; role: string; joinedAt: string };
type ConnectTab = "claudeCode" | "claudeDesktop" | "other";

function normalizeRole(role: string): "owner" | "manager" | "qa_engineer" {
  const n = (role ?? "").trim().toLowerCase().replace(/-/g, "_").replace(/ /g, "_");
  if (n === "owner") return "owner";
  if (["manager", "admin", "test_manager"].includes(n)) return "manager";
  return "qa_engineer";
}

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function scopeLabel(scopes: string[]): string {
  const hasRead = scopes.includes("read");
  const hasWrite = scopes.includes("write");
  if (hasRead && hasWrite) return "Read & Write";
  if (hasWrite) return "Write only";
  return "Read only";
}

export default function ApiTokensPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [tokensLoading, setTokensLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createStep, setCreateStep] = useState<"form" | "reveal">("form");
  const [newTokenName, setNewTokenName] = useState("");
  const [newTokenScopes, setNewTokenScopes] = useState({ read: true, write: true });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [revealedToken, setRevealedToken] = useState<ApiTokenWithSecret | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const [connectTab, setConnectTab] = useState<ConnectTab>("claudeCode");

  const loadTokens = useCallback(async () => {
    try {
      const list = await listApiKeys(projectId);
      setTokens(list);
      setListError(null);
    } catch {
      setListError("Failed to load API tokens.");
    } finally {
      setTokensLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    authMe().then((me) => {
      if (!me) {
        router.replace("/login");
        return;
      }
      setCurrentUserId(me.userId);
      listProjectMembers(projectId).then(setProjectMembers).catch(() => {});
      loadTokens().catch(() => {});
    });
  }, [loadTokens, projectId, router]);

  const currentUserRole = currentUserId
    ? normalizeRole(projectMembers.find((m) => m.userId === currentUserId)?.role ?? "qa_engineer")
    : "qa_engineer";
  const canManageApiTokens = currentUserRole === "owner" || currentUserRole === "manager";

  function openCreateModal() {
    setNewTokenName("");
    setNewTokenScopes({ read: true, write: true });
    setCreateError(null);
    setCreateStep("form");
    setCreateModalOpen(true);
  }

  async function handleCreateToken(e: FormEvent) {
    e.preventDefault();
    const name = newTokenName.trim();
    if (!name) {
      setCreateError("Name is required.");
      return;
    }
    const scopes = Object.entries(newTokenScopes)
      .filter(([, checked]) => checked)
      .map(([scope]) => scope);
    if (scopes.length === 0) {
      setCreateError("Select at least one scope.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const result = await createApiKey(projectId, { name, scopes });
      setTokens((prev) => [result, ...prev]);
      setRevealedToken(result);
      setCreateStep("reveal");
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create token.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(tokenId: string) {
    setRevokingId(tokenId);
    try {
      await revokeApiKey(projectId, tokenId);
      setTokens((prev) => prev.filter((t) => t.id !== tokenId));
    } catch {
      setListError("Failed to revoke token.");
    } finally {
      setRevokingId(null);
    }
  }

  function closeCreateModal() {
    if (createStep === "reveal") return;
    setCreateModalOpen(false);
  }

  function finishReveal() {
    setCreateModalOpen(false);
    setCreateStep("form");
    setNewTokenName("");
    setNewTokenScopes({ read: true, write: true });
  }

  const mcpUrl = getMcpUrl(projectId);
  const tokenForSnippets = revealedToken?.token ?? "<YOUR_API_TOKEN>";

  const claudeCodeCli = `claude mcp add --transport http tesbo ${mcpUrl} --header "Authorization: Bearer ${tokenForSnippets}"`;
  const mcpJsonSnippet = `{
  "mcpServers": {
    "tesbo": {
      "type": "http",
      "url": "${mcpUrl}",
      "headers": { "Authorization": "Bearer ${tokenForSnippets}" }
    }
  }
}`;
  const curlSnippet = `curl -X POST '${mcpUrl}' \\
  -H 'Authorization: Bearer ${tokenForSnippets}' \\
  -H 'Content-Type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`;

  const header = (
    <PageHeader
      title={
        <>
          <IconKey size={26} stroke={1.75} />
          API &amp; MCP access
        </>
      }
      subtitle="Create tokens and connect AI agents like Claude Code or Claude Desktop to this project."
      breadcrumb={
        <Link
          href={`/projects/${projectId}/settings?tab=apiTokens`}
          className="inline-flex items-center gap-1 hover:text-[var(--foreground)]"
        >
          Settings <IconChevronRight size={13} /> API &amp; MCP
        </Link>
      }
    />
  );

  return (
    <StandardPageLayout header={header}>
      {!canManageApiTokens && (
        <Card className="p-4">
          <p className="text-sm text-[var(--muted)]">
            Only project managers and owners can create or revoke API tokens.
          </p>
        </Card>
      )}

      {canManageApiTokens && (
        <div>
          <Button type="button" onClick={openCreateModal}>
            Create token
          </Button>
        </div>
      )}

      {listError && <p className="text-sm text-[var(--error-foreground)]">{listError}</p>}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="tesbo-table min-w-full text-sm">
            <thead>
              <tr className="text-left text-[var(--muted)]">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Token</th>
                <th className="px-4 py-3 font-medium">Scopes</th>
                <th className="px-4 py-3 font-medium">Last used</th>
                <th className="px-4 py-3 font-medium">Created</th>
                {canManageApiTokens && <th className="px-4 py-3 font-medium text-right">Action</th>}
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => (
                <tr key={token.id}>
                  <td className="px-4 py-3 text-[var(--foreground)]">{token.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{token.tokenPrefix}</td>
                  <td className="px-4 py-3">
                    <StatusChip tone="brand" dot>
                      {scopeLabel(token.scopes)}
                    </StatusChip>
                  </td>
                  <td className="px-4 py-3 text-[var(--muted)]">{formatDate(token.lastUsedAt)}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{formatDate(token.createdAt)}</td>
                  {canManageApiTokens && (
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => handleRevoke(token.id)}
                        disabled={revokingId === token.id}
                        className="text-[var(--error-foreground)] hover:underline disabled:opacity-50"
                      >
                        {revokingId === token.id ? "Revoking…" : "Revoke"}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {!tokensLoading && tokens.length === 0 && (
                <tr>
                  <td colSpan={canManageApiTokens ? 6 : 5} className="px-4 py-6 text-center text-[var(--muted)]">
                    No API tokens yet.
                  </td>
                </tr>
              )}
              {tokensLoading && (
                <tr>
                  <td colSpan={canManageApiTokens ? 6 : 5} className="px-4 py-6 text-center text-[var(--muted)]">
                    Loading tokens…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-4 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-[var(--foreground)]">Connect an MCP client</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {revealedToken
              ? "Showing the token you just created — copy it into your config now."
              : <>Replace <code className="font-mono text-xs">&lt;YOUR_API_TOKEN&gt;</code> below with a token from the list above.</>}
          </p>
        </div>

        <div className="flex gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-1 text-sm">
          <button
            type="button"
            onClick={() => setConnectTab("claudeCode")}
            className={`flex-1 rounded-md px-3 py-1.5 font-medium transition-colors ${
              connectTab === "claudeCode" ? "bg-[var(--surface)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted)]"
            }`}
          >
            Claude Code
          </button>
          <button
            type="button"
            onClick={() => setConnectTab("claudeDesktop")}
            className={`flex-1 rounded-md px-3 py-1.5 font-medium transition-colors ${
              connectTab === "claudeDesktop" ? "bg-[var(--surface)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted)]"
            }`}
          >
            Claude Desktop
          </button>
          <button
            type="button"
            onClick={() => setConnectTab("other")}
            className={`flex-1 rounded-md px-3 py-1.5 font-medium transition-colors ${
              connectTab === "other" ? "bg-[var(--surface)] text-[var(--foreground)] shadow-sm" : "text-[var(--muted)]"
            }`}
          >
            Other / curl
          </button>
        </div>

        {connectTab === "claudeCode" && (
          <div className="space-y-3">
            <p className="text-sm text-[var(--muted)]">Run this once from your terminal:</p>
            <div className="relative">
              <pre className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3 pr-12 font-mono text-xs text-[var(--foreground)] overflow-x-auto">{claudeCodeCli}</pre>
              <CopyButton value={claudeCodeCli} iconOnly className="absolute right-2 top-2" />
            </div>
            <p className="text-sm text-[var(--muted)]">Or add this to <code className="font-mono text-xs">.mcp.json</code> (project) or <code className="font-mono text-xs">~/.claude.json</code> (user):</p>
            <div className="relative">
              <pre className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3 pr-12 font-mono text-xs text-[var(--foreground)] overflow-x-auto whitespace-pre">{mcpJsonSnippet}</pre>
              <CopyButton value={mcpJsonSnippet} iconOnly className="absolute right-2 top-2" />
            </div>
          </div>
        )}

        {connectTab === "claudeDesktop" && (
          <div className="space-y-3">
            <p className="text-sm text-[var(--muted)]">
              Add this to your Claude Desktop config — macOS: <code className="font-mono text-xs">~/Library/Application Support/Claude/claude_desktop_config.json</code>, Windows: <code className="font-mono text-xs">%APPDATA%\Claude\claude_desktop_config.json</code>
            </p>
            <div className="relative">
              <pre className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3 pr-12 font-mono text-xs text-[var(--foreground)] overflow-x-auto whitespace-pre">{mcpJsonSnippet}</pre>
              <CopyButton value={mcpJsonSnippet} iconOnly className="absolute right-2 top-2" />
            </div>
          </div>
        )}

        {connectTab === "other" && (
          <div className="space-y-3">
            <p className="text-sm text-[var(--muted)]">
              Any MCP-compatible client can call the JSON-RPC 2.0 endpoint directly:
            </p>
            <div className="relative">
              <pre className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] p-3 pr-12 font-mono text-xs text-[var(--foreground)] overflow-x-auto whitespace-pre">{curlSnippet}</pre>
              <CopyButton value={curlSnippet} iconOnly className="absolute right-2 top-2" />
            </div>
            <p className="text-xs text-[var(--muted-soft)]">
              Protocol methods: <code className="font-mono">initialize</code>, <code className="font-mono">ping</code>, <code className="font-mono">tools/list</code>, <code className="font-mono">tools/call</code>. Available tools: list_projects, list_testcases, create_testcase, create_suite, create_cycle_from_plan, record_execution_result, create_bug, get_requirement_matrix.
            </p>
          </div>
        )}
      </Card>

      <Modal
        open={createModalOpen}
        onClose={closeCreateModal}
        title={createStep === "form" ? "Create API token" : "Copy your new token"}
      >
        {createStep === "form" && (
          <form onSubmit={handleCreateToken} className="space-y-4">
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input
                type="text"
                value={newTokenName}
                onChange={(e) => setNewTokenName(e.target.value)}
                placeholder="e.g. Claude Code — my laptop"
                disabled={creating}
                autoFocus
              />
            </Field>
            <div className="space-y-3">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={newTokenScopes.read}
                  onChange={(e) => setNewTokenScopes((prev) => ({ ...prev, read: e.target.checked }))}
                  className="mt-0.5"
                  disabled={creating}
                />
                <div>
                  <span className="text-sm font-medium text-[var(--foreground)]">Read</span>
                  <p className="text-xs text-[var(--muted)] mt-0.5">
                    List and search test cases, suites, cycles, and results.
                  </p>
                </div>
              </label>
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={newTokenScopes.write}
                  onChange={(e) => setNewTokenScopes((prev) => ({ ...prev, write: e.target.checked }))}
                  className="mt-0.5"
                  disabled={creating}
                />
                <div>
                  <span className="text-sm font-medium text-[var(--foreground)]">Write</span>
                  <p className="text-xs text-[var(--muted)] mt-0.5">
                    Create test cases, suites, cycles, execution results, and bugs.
                  </p>
                </div>
              </label>
            </div>
            {createError && <p className="text-sm text-[var(--error-foreground)]">{createError}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={closeCreateModal} disabled={creating}>
                Cancel
              </Button>
              <Button type="submit" disabled={creating}>
                {creating ? "Creating…" : "Create token"}
              </Button>
            </div>
          </form>
        )}

        {createStep === "reveal" && revealedToken && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Input
                type="text"
                readOnly
                value={revealedToken.token}
                onClick={(e) => (e.target as HTMLInputElement).select()}
                className="flex-1 bg-[var(--surface-secondary)] font-mono truncate"
              />
              <CopyButton value={revealedToken.token} label="Copy" />
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              This is the only time you&apos;ll see this token. Copy it now — for example, paste it directly into the connection instructions below.
            </div>
            <div className="flex justify-end">
              <Button type="button" onClick={finishReveal}>
                Done
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </StandardPageLayout>
  );
}
