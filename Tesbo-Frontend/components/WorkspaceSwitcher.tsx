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
import { avatarColor } from "@/lib/avatarColors";

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
        {/* Seeded on the workspace id so each workspace keeps its own mark — part of 10198836413. */}
        <span
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-xs font-semibold text-white"
          style={{ backgroundColor: avatarColor(active.id || active.name) }}
        >
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
        /*
         * Basecamp 10212564946 — "Workspace menu should have an independent scrollbar when multiple
         * workspaces are added". The menu had no height bound, so it grew one row per workspace: at 11
         * it ran past the bottom of the viewport and took "Create new workspace" with it, leaving the
         * only way to add a workspace unreachable.
         *
         * The menu is capped to the viewport (max-h) and the WORKSPACE LIST scrolls inside it, so the
         * separator and "Create new workspace" stay pinned and reachable at any number of workspaces.
         * `flex` + `min-h-0` is what lets the list actually shrink rather than overflowing the box.
         */
        <div className="absolute left-2 top-full z-40 mt-1 flex max-h-[min(70vh,26rem)] w-64 flex-col rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-[var(--shadow-elevated)]">
        <div data-testid="workspace-switcher-list" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
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
        </div>
          {error && <p className="px-3 py-1 text-[11px] text-[var(--status-fail-text)]">{error}</p>}
          <div className="my-1 shrink-0 border-t border-[var(--border)]" />
          <button
            type="button"
            data-testid="create-workspace-action"
            onClick={() => {
              setIsOpen(false);
              setIsCreateOpen(true);
            }}
            className="flex w-full shrink-0 items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--foreground)] hover:bg-[var(--surface-secondary)]"
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
              onChange={(e) => {
                setOrgName(e.target.value);
                if (createError) setCreateError("");
              }}
              placeholder="My Team"
              disabled={creating}
              autoFocus
              aria-invalid={Boolean(createError)}
            />
            {createError && <FieldError>{createError}</FieldError>}
          </Field>
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
