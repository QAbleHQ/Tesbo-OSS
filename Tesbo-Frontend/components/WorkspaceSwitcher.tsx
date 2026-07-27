"use client";

import { useEffect, useRef, useState } from "react";
import { IconChevronDown, IconCheck, IconPlus } from "@tabler/icons-react";
import {
  createAdditionalWorkspace,
  listWorkspaces,
  switchWorkspace,
  type WorkspaceListItem,
} from "@/lib/api";
import { Button, Field, FieldError, FieldLabel, Input, Modal } from "@/components/ui";

function roleLabel(role?: string): string {
  const n = (role ?? "").trim().toLowerCase();
  if (n === "owner") return "Owner";
  if (n === "manager") return "Manager";
  return "QA Engineer";
}

function planLabel(plan?: string): string {
  return plan === "pro" ? "Pro" : "Launch";
}

export default function WorkspaceSwitcher({ isCollapsed }: { isCollapsed: boolean }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceListItem[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  const loadWorkspaces = async () => {
    try {
      const data = await listWorkspaces();
      setWorkspaces(data);
    } catch {
      // Not onboarded yet, or request failed — switcher just stays empty.
    }
  };

  useEffect(() => {
    loadWorkspaces();
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setIsOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen]);

  const active = workspaces.find((w) => w.isActive) ?? workspaces[0];
  if (!active) return null;

  async function handleSwitch(id: string) {
    if (id === active.id) {
      setIsOpen(false);
      return;
    }
    setError("");
    setSwitchingId(id);
    try {
      await switchWorkspace(id);
      setIsOpen(false);
      // Hard navigation: /projects and every other page here fetch their data
      // client-side on mount, so a same-route router.push()/refresh() would not
      // re-run those fetches. A full reload guarantees everything reflects the
      // newly active workspace.
      window.location.href = "/projects";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to switch workspace");
      setSwitchingId(null);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError("");
    if (!orgName.trim()) {
      setCreateError("Workspace name is required");
      return;
    }
    setCreating(true);
    try {
      await createAdditionalWorkspace({ orgName: orgName.trim() });
      setOrgName("");
      setIsCreateOpen(false);
      window.location.href = "/projects";
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create workspace");
      setCreating(false);
    }
  }

  return (
    <div ref={menuRef} className="relative border-b border-[var(--glass-border)] px-2.5 py-2">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className={`flex w-full items-center gap-2 rounded-xl border border-transparent px-1.5 py-1.5 text-left transition-colors hover:border-[var(--glass-border)] hover:bg-[var(--glass-surface-muted)] ${
          isCollapsed ? "justify-center" : ""
        }`}
        aria-label="Switch workspace"
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[var(--cta-primary)] text-xs font-semibold text-white">
          {active.name.slice(0, 1).toUpperCase()}
        </span>
        {!isCollapsed && (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-[var(--foreground)]">{active.name}</span>
              <span className="block truncate text-[11px] text-[var(--muted)]">
                {roleLabel(active.role)} · {planLabel(active.plan)}
              </span>
            </span>
            <IconChevronDown className="h-[14px] w-[14px] shrink-0 text-[var(--muted-soft)]" />
          </>
        )}
      </button>

      {isOpen && (
        <div className="absolute left-2 top-full z-40 mt-1 w-64 rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-[var(--shadow-elevated)]">
          {workspaces.map((w) => (
            <button
              key={w.id}
              type="button"
              disabled={switchingId === w.id}
              onClick={() => handleSwitch(w.id)}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--foreground)] hover:bg-[var(--surface-secondary)] disabled:opacity-60"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{w.name}</span>
                <span className="block truncate text-[11px] text-[var(--muted)]">
                  {roleLabel(w.role)} · {planLabel(w.plan)}
                </span>
              </span>
              {w.isActive && <IconCheck className="h-[14px] w-[14px] shrink-0 text-[var(--denim)]" />}
            </button>
          ))}
          {error && <p className="px-3 py-1 text-[11px] text-[var(--status-fail-text)]">{error}</p>}
          <div className="my-1 border-t border-[var(--border)]" />
          <button
            type="button"
            onClick={() => {
              setIsOpen(false);
              setIsCreateOpen(true);
            }}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--foreground)] hover:bg-[var(--surface-secondary)]"
          >
            <IconPlus className="h-[14px] w-[14px] shrink-0" />
            Create new workspace
          </button>
        </div>
      )}

      <Modal open={isCreateOpen} onClose={() => setIsCreateOpen(false)} title="Create workspace" className="max-w-[420px]">
        <form onSubmit={handleCreate} className="space-y-4">
          <Field>
            <FieldLabel htmlFor="newOrgName">Organization / workspace name</FieldLabel>
            <Input
              id="newOrgName"
              type="text"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="My Team"
              disabled={creating}
              autoFocus
            />
          </Field>
          {createError && <FieldError>{createError}</FieldError>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setIsCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button type="submit" disabled={creating}>
              {creating ? "Creating…" : "Create"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
