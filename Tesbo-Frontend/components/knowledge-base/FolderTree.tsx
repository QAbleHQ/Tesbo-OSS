"use client";

import { IconChevronDown, IconChevronRight, IconDots, IconFolder, IconFolderPlus, IconPencil, IconArrowRight, IconTrash } from "@tabler/icons-react";
import type { KnowledgeFolderTreeNode } from "@/lib/api";
import { Menu, MenuItem } from "@/components/knowledge-base/Menu";

export type FolderAction = "create-subfolder" | "rename" | "move" | "delete";

export function FolderTreeNodeRow({
  node,
  depth,
  selectedId,
  onSelect,
  onAction,
  expanded,
  toggleExpanded,
}: {
  node: KnowledgeFolderTreeNode;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAction: (action: FolderAction, folder: KnowledgeFolderTreeNode) => void;
  expanded: Set<string>;
  toggleExpanded: (id: string) => void;
}) {
  const isOpen = expanded.has(node.id) || node.isRoot;
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div
        className={`group flex items-center gap-1 rounded-[6px] py-1.5 pr-1.5 text-[13px] cursor-pointer ${
          selectedId === node.id ? "bg-[var(--brand-soft)] text-[var(--brand-primary)] font-medium" : "text-[var(--foreground)] hover:bg-[var(--surface-secondary)]"
        }`}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
        role="button"
        tabIndex={0}
        onClick={() => onSelect(node.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(node.id);
          }
        }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggleExpanded(node.id);
            }}
            className="shrink-0 text-[var(--muted-soft)]"
          >
            {isOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
          </button>
        ) : (
          <span className="w-[14px] shrink-0" />
        )}
        <IconFolder size={15} stroke={1.75} className="shrink-0 text-[var(--muted)]" />
        <span className="truncate flex-1">{node.name}</span>
        {!node.isRoot && (
          <Menu
            align="right"
            trigger={
              <button type="button" onClick={(e) => e.stopPropagation()} className="shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-[var(--surface-tertiary)]">
                <IconDots size={14} />
              </button>
            }
          >
            {(close) => (
              <>
                <MenuItem onClick={() => { onAction("create-subfolder", node); close(); }}>
                  <IconFolderPlus size={14} /> Create subfolder
                </MenuItem>
                <MenuItem onClick={() => { onAction("rename", node); close(); }}>
                  <IconPencil size={14} /> Rename
                </MenuItem>
                <MenuItem onClick={() => { onAction("move", node); close(); }}>
                  <IconArrowRight size={14} /> Move
                </MenuItem>
                <MenuItem danger onClick={() => { onAction("delete", node); close(); }}>
                  <IconTrash size={14} /> Delete
                </MenuItem>
              </>
            )}
          </Menu>
        )}
      </div>
      {isOpen && hasChildren && (
        <div>
          {node.children.map((child) => (
            <FolderTreeNodeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              onAction={onAction}
              expanded={expanded}
              toggleExpanded={toggleExpanded}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Flattens the tree into a depth-indented option list — used by the Move modal's
// destination-folder <select>.
export function flattenFolders(node: KnowledgeFolderTreeNode, depth = 0): Array<{ id: string; label: string }> {
  const label = `${"— ".repeat(depth)}${node.isRoot ? "Knowledge base" : node.name}`;
  return [{ id: node.id, label }, ...node.children.flatMap((child) => flattenFolders(child, depth + 1))];
}

// Returns the chain of ancestor folder ids from root to (but not including) targetId, so the
// tree can auto-expand the path down to whichever folder is currently selected.
export function findAncestorIds(node: KnowledgeFolderTreeNode, targetId: string, trail: string[] = []): string[] | null {
  if (node.id === targetId) return trail;
  for (const child of node.children) {
    const found = findAncestorIds(child, targetId, [...trail, node.id]);
    if (found) return found;
  }
  return null;
}
