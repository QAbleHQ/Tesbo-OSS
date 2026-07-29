"use client";

import { useState } from "react";
import { IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import {
  deleteCustomFieldDefinition,
  reorderCustomFieldDefinitions,
  setCustomFieldDefinitionStatus,
  type CustomFieldDefinition,
} from "@/lib/api";
import { Button, Card, Modal, StatusChip } from "@/components/ui";
import { FIELD_TYPE_LABELS } from "./customFieldTypes";

function statusTone(status: string): "success" | "neutral" | "error" {
  if (status === "active") return "success";
  if (status === "archived") return "error";
  return "neutral";
}

export default function CustomFieldDefinitionList({
  projectId,
  definitions,
  onEdit,
  onChanged,
}: {
  projectId: string;
  definitions: CustomFieldDefinition[];
  onEdit: (definition: CustomFieldDefinition) => void;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CustomFieldDefinition | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const reorderable = definitions.filter((d) => d.status !== "archived").sort((a, b) => a.displayOrder - b.displayOrder);
  const archived = definitions.filter((d) => d.status === "archived");
  const ordered = [...reorderable, ...archived];

  async function move(definition: CustomFieldDefinition, direction: -1 | 1) {
    const index = reorderable.findIndex((d) => d.id === definition.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= reorderable.length) return;
    const next = [...reorderable];
    [next[index], next[target]] = [next[target], next[index]];
    setBusyId(definition.id);
    setError(null);
    try {
      await reorderCustomFieldDefinitions(projectId, next.map((d) => d.id));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reorder fields.");
    } finally {
      setBusyId(null);
    }
  }

  async function toggleActive(definition: CustomFieldDefinition) {
    setBusyId(definition.id);
    setError(null);
    try {
      await setCustomFieldDefinitionStatus(projectId, definition.id, definition.status === "active" ? "inactive" : "active");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update field status.");
    } finally {
      setBusyId(null);
    }
  }

  async function archive(definition: CustomFieldDefinition) {
    if (!window.confirm(`Archive "${definition.name}"? Archived fields become read-only everywhere.`)) return;
    setBusyId(definition.id);
    setError(null);
    try {
      await setCustomFieldDefinitionStatus(projectId, definition.id, "archived");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to archive field.");
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setBusyId(deleteTarget.id);
    setDeleteError(null);
    try {
      await deleteCustomFieldDefinition(projectId, deleteTarget.id);
      setDeleteTarget(null);
      onChanged();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete field.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      {error && <p className="mb-2 text-sm text-[var(--error)]">{error}</p>}
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="tesbo-table min-w-full text-sm">
            <thead>
              <tr className="text-left text-[var(--muted)]">
                <th className="px-4 py-3 font-medium">Order</th>
                <th className="px-4 py-3 font-medium">Field</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">Required</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">In use</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((definition) => {
                const isArchived = definition.status === "archived";
                const busy = busyId === definition.id;
                const indexInReorderable = reorderable.findIndex((d) => d.id === definition.id);
                return (
                  <tr key={definition.id}>
                    <td className="px-4 py-3">
                      {!isArchived && (
                        <div className="flex flex-col">
                          <button
                            type="button"
                            onClick={() => move(definition, -1)}
                            disabled={busy || indexInReorderable === 0}
                            className="text-[var(--muted-soft)] hover:text-[var(--foreground)] disabled:opacity-30"
                            aria-label="Move up"
                          >
                            <IconChevronUp size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={() => move(definition, 1)}
                            disabled={busy || indexInReorderable === reorderable.length - 1}
                            className="text-[var(--muted-soft)] hover:text-[var(--foreground)] disabled:opacity-30"
                            aria-label="Move down"
                          >
                            <IconChevronDown size={14} />
                          </button>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-[var(--foreground)]">{definition.name}</div>
                      {definition.description && <div className="text-xs text-[var(--muted)]">{definition.description}</div>}
                    </td>
                    <td className="px-4 py-3 text-[var(--muted)]">{FIELD_TYPE_LABELS[definition.fieldType]}</td>
                    <td className="px-4 py-3 text-[var(--muted)]">{definition.required ? "Required" : "Optional"}</td>
                    <td className="px-4 py-3">
                      <StatusChip tone={statusTone(definition.status)} dot>
                        {definition.status === "active" ? "Active" : definition.status === "inactive" ? "Inactive" : "Archived"}
                      </StatusChip>
                    </td>
                    <td className="px-4 py-3 text-[var(--muted)]">{definition.isUsed ? "Yes" : "No"}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-2">
                        {!isArchived && (
                          <>
                            <button type="button" onClick={() => onEdit(definition)} disabled={busy} className="text-[var(--brand-primary)] hover:underline disabled:opacity-50">
                              Edit
                            </button>
                            <button type="button" onClick={() => toggleActive(definition)} disabled={busy} className="text-[var(--foreground)] hover:underline disabled:opacity-50">
                              {definition.status === "active" ? "Deactivate" : "Activate"}
                            </button>
                            <button type="button" onClick={() => archive(definition)} disabled={busy} className="text-[var(--muted)] hover:underline disabled:opacity-50">
                              Archive
                            </button>
                          </>
                        )}
                        {!definition.isUsed && (
                          <button
                            type="button"
                            onClick={() => {
                              setDeleteError(null);
                              setDeleteTarget(definition);
                            }}
                            disabled={busy}
                            className="text-[var(--error)] hover:underline disabled:opacity-50"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {ordered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-[var(--muted)]">
                    No custom fields yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} title="Delete custom field">
        <div className="space-y-4">
          <p className="text-sm text-[var(--muted)]">
            Permanently delete &quot;{deleteTarget?.name}&quot;? This can&apos;t be undone. Fields with recorded values can&apos;t be deleted — archive them instead.
          </p>
          {deleteError && <p className="text-sm text-[var(--error)]">{deleteError}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={confirmDelete} disabled={busyId === deleteTarget?.id}>
              {busyId === deleteTarget?.id ? "Deleting…" : "Delete permanently"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
