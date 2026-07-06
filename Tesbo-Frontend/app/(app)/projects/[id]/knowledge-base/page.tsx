"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  IconFolder,
  IconFileText,
  IconFile,
  IconChevronRight,
  IconChevronDown,
  IconDots,
  IconPlus,
  IconSearch,
  IconUpload,
  IconTrash,
  IconPencil,
  IconFolderPlus,
  IconArrowRight,
  IconCopy,
  IconDownload,
  IconX,
} from "@tabler/icons-react";
import {
  authMe,
  getKnowledgeFolderTree,
  listKnowledgeFolderItems,
  createKnowledgeFolder,
  updateKnowledgeFolder,
  moveKnowledgeFolder,
  deleteKnowledgeFolder,
  createKnowledgeDocument,
  moveKnowledgeDocument,
  duplicateKnowledgeDocument,
  deleteKnowledgeDocument,
  uploadKnowledgeFiles,
  moveKnowledgeFile,
  deleteKnowledgeFile,
  getKnowledgeFileDownloadUrl,
  searchKnowledgeBase,
  type KnowledgeFolderTreeNode,
  type KnowledgeItem,
  type KnowledgeBreadcrumbEntry,
} from "@/lib/api";
import { Button, Input, Modal, Field, FieldLabel, StatusChip, EmptyStateBlock } from "@/components/ui";
import { PageHeader, StandardPageLayout } from "@/components/workflows";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DocNode = any;

function heading(level: 1 | 2 | 3, text: string): DocNode {
  return { type: "heading", attrs: { level }, content: [{ type: "text", text }] };
}
function paragraph(text?: string): DocNode {
  return text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" };
}
function bulletList(items: string[]): DocNode {
  return {
    type: "bulletList",
    content: items.map((item) => ({ type: "listItem", content: [paragraph(item)] })),
  };
}
function doc(...content: DocNode[]): DocNode {
  return { type: "doc", content };
}

type DocumentTemplate = {
  key: string;
  label: string;
  description: string;
  documentType: string;
  content: DocNode | null;
};

const DOCUMENT_TEMPLATES: DocumentTemplate[] = [
  {
    key: "blank",
    label: "Blank document",
    description: "Start from an empty page.",
    documentType: "general",
    content: null,
  },
  {
    key: "test_plan",
    label: "Test Plan",
    description: "Objective, scope, strategy, cases, timeline, and risks.",
    documentType: "general",
    content: doc(
      heading(1, "Test Plan"),
      heading(2, "Objective"), paragraph(),
      heading(2, "Scope"), paragraph(),
      heading(2, "Test Strategy"), paragraph(),
      heading(2, "Test Cases"), paragraph(),
      heading(2, "Timeline"), paragraph(),
      heading(2, "Risks"), paragraph()
    ),
  },
  {
    key: "feature_requirements",
    label: "Feature Requirements",
    description: "Overview, user stories, and acceptance criteria for a feature.",
    documentType: "requirement_note",
    content: doc(
      heading(1, "Feature Requirements"),
      heading(2, "Overview"), paragraph(),
      heading(2, "User Stories"), bulletList(["As a ..., I want to ..., so that ..."]),
      heading(2, "Acceptance Criteria"), bulletList(["Given ..., when ..., then ..."]),
      heading(2, "Out of Scope"), paragraph()
    ),
  },
  {
    key: "api_note",
    label: "API Notes",
    description: "Endpoint, request/response shape, and error cases.",
    documentType: "api_note",
    content: doc(
      heading(1, "API Notes"),
      heading(2, "Endpoint"), paragraph(),
      heading(2, "Request"), paragraph(),
      heading(2, "Response"), paragraph(),
      heading(2, "Error Cases"), paragraph()
    ),
  },
  {
    key: "release_note",
    label: "Release Notes",
    description: "Summary, new features, bug fixes, and known issues.",
    documentType: "release_note",
    content: doc(
      heading(1, "Release Notes"),
      heading(2, "Summary"), paragraph(),
      heading(2, "New Features"), paragraph(),
      heading(2, "Bug Fixes"), paragraph(),
      heading(2, "Known Issues"), paragraph()
    ),
  },
  {
    key: "test_data",
    label: "Test Data",
    description: "Sample users, input data, and boundary values.",
    documentType: "test_data_note",
    content: doc(
      heading(1, "Test Data"),
      heading(2, "Sample Users"), paragraph(),
      heading(2, "Input Data"), paragraph(),
      heading(2, "Boundary Values"), paragraph()
    ),
  },
];

function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return "Today";
  return date.toLocaleDateString();
}

function itemIcon(item: KnowledgeItem) {
  if (item.type === "folder") return <IconFolder size={17} stroke={1.75} className="text-[var(--brand-primary)]" />;
  if (item.type === "document") return <IconFileText size={17} stroke={1.75} className="text-[var(--info)]" />;
  return <IconFile size={17} stroke={1.75} className="text-[var(--muted)]" />;
}

function itemLabel(item: KnowledgeItem): string {
  if (item.type === "folder" || item.type === "document") return (item as { name?: string; title?: string }).name || (item as { title?: string }).title || "Untitled";
  return (item as { originalFileName?: string }).originalFileName || "File";
}

function aiMemoryTone(status: string): "draft" | "success" | "error" {
  if (status === "approved") return "success";
  if (status === "rejected") return "error";
  return "draft";
}

// ─── Dropdown menu (generic) ────────────────────────────────────────────────
// Renders through a portal at a fixed (viewport-relative) position computed from the
// trigger's bounding rect, so the menu is never clipped by an ancestor with `overflow-x`
// set (e.g. the content table's horizontal scroll wrapper).

function Menu({
  trigger,
  children,
  align = "left",
}: {
  trigger: React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function updatePosition() {
      if (!triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
      setPosition({ top: rect.bottom + 4, left: align === "right" ? rect.right : rect.left });
    }
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, align]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div className="inline-block" ref={triggerRef}>
      <div onClick={() => setOpen((v) => !v)}>{trigger}</div>
      {open && position && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={menuRef}
              style={{
                position: "fixed",
                top: position.top,
                left: position.left,
                transform: align === "right" ? "translateX(-100%)" : undefined,
              }}
              className="z-50 min-w-[180px] rounded-[8px] border border-[var(--border)] bg-[var(--surface-overlay)] py-1 shadow-[var(--shadow-elevated)]"
            >
              {children(() => setOpen(false))}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

function MenuItem({ onClick, danger, children }: { onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors ${
        danger ? "text-[var(--error)] hover:bg-[var(--error-soft)]" : "text-[var(--foreground)] hover:bg-[var(--surface-secondary)]"
      }`}
    >
      {children}
    </button>
  );
}

// ─── Folder tree (left panel) ───────────────────────────────────────────────

function FolderTreeNodeRow({
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
  onAction: (action: "create-subfolder" | "rename" | "move" | "delete", folder: KnowledgeFolderTreeNode) => void;
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
        onClick={() => onSelect(node.id)}
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

// ─── Folder picker (used by Move modals) ────────────────────────────────────

function flattenFolders(node: KnowledgeFolderTreeNode, depth = 0): Array<{ id: string; label: string }> {
  const label = `${"— ".repeat(depth)}${node.isRoot ? "Knowledge base" : node.name}`;
  return [{ id: node.id, label }, ...node.children.flatMap((child) => flattenFolders(child, depth + 1))];
}

function findAncestorIds(node: KnowledgeFolderTreeNode, targetId: string, trail: string[] = []): string[] | null {
  if (node.id === targetId) return trail;
  for (const child of node.children) {
    const found = findAncestorIds(child, targetId, [...trail, node.id]);
    if (found) return found;
  }
  return null;
}

// ─── Modals ─────────────────────────────────────────────────────────────────

function CreateFolderModal({
  open,
  onClose,
  onCreate,
  saving,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, description: string) => void;
  saving: boolean;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
    }
  }, [open]);
  return (
    <Modal open={open} onClose={onClose} title="Create folder">
      <div className="space-y-4">
        <Field>
          <FieldLabel>Folder name</FieldLabel>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Payment Module" />
        </Field>
        <Field>
          <FieldLabel>Description (optional)</FieldLabel>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What belongs in this folder?" />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={!name.trim() || saving} onClick={() => onCreate(name.trim(), description.trim())}>
            {saving ? "Creating…" : "Create folder"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function RenameFolderModal({
  open,
  initialName,
  onClose,
  onSave,
  saving,
}: {
  open: boolean;
  initialName: string;
  onClose: () => void;
  onSave: (name: string) => void;
  saving: boolean;
}) {
  const [name, setName] = useState(initialName);
  useEffect(() => {
    if (open) setName(initialName);
  }, [open, initialName]);
  return (
    <Modal open={open} onClose={onClose} title="Rename folder">
      <div className="space-y-4">
        <Field>
          <FieldLabel>Folder name</FieldLabel>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={!name.trim() || saving} onClick={() => onSave(name.trim())}>{saving ? "Saving…" : "Save"}</Button>
        </div>
      </div>
    </Modal>
  );
}

function MoveModal({
  open,
  tree,
  excludeId,
  onClose,
  onMove,
  saving,
}: {
  open: boolean;
  tree: KnowledgeFolderTreeNode | null;
  excludeId?: string;
  onClose: () => void;
  onMove: (folderId: string) => void;
  saving: boolean;
}) {
  const [target, setTarget] = useState("");
  const options = tree ? flattenFolders(tree).filter((f) => f.id !== excludeId) : [];
  useEffect(() => {
    if (open) setTarget(tree?.id || "");
  }, [open, tree]);
  return (
    <Modal open={open} onClose={onClose} title="Move to folder">
      <div className="space-y-4">
        <Field>
          <FieldLabel>Destination folder</FieldLabel>
          <select
            className="h-9 w-full rounded-[6px] border border-[var(--border)] bg-[var(--surface)] px-3 text-[14px] text-[var(--foreground)]"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            {options.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={!target || saving} onClick={() => onMove(target)}>{saving ? "Moving…" : "Move"}</Button>
        </div>
      </div>
    </Modal>
  );
}

function CreateDocumentModal({
  open,
  onClose,
  onCreate,
  saving,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (title: string, template: DocumentTemplate) => void;
  saving: boolean;
}) {
  const [title, setTitle] = useState("");
  const [templateKey, setTemplateKey] = useState(DOCUMENT_TEMPLATES[0].key);
  useEffect(() => {
    if (open) {
      setTitle("");
      setTemplateKey(DOCUMENT_TEMPLATES[0].key);
    }
  }, [open]);
  const template = DOCUMENT_TEMPLATES.find((t) => t.key === templateKey) || DOCUMENT_TEMPLATES[0];
  return (
    <Modal open={open} onClose={onClose} title="Create document" className="max-w-2xl">
      <div className="space-y-4">
        <Field>
          <FieldLabel>Document title</FieldLabel>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="e.g. Login Requirements" />
        </Field>
        <Field>
          <FieldLabel>Template</FieldLabel>
          <div className="grid grid-cols-2 gap-2">
            {DOCUMENT_TEMPLATES.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTemplateKey(t.key)}
                className={`rounded-[8px] border p-3 text-left transition-colors ${
                  templateKey === t.key
                    ? "border-[var(--brand-primary)] bg-[var(--brand-soft)]"
                    : "border-[var(--border)] hover:bg-[var(--surface-secondary)]"
                }`}
              >
                <p className="text-[13px] font-medium text-[var(--foreground)]">{t.label}</p>
                <p className="mt-0.5 text-[12px] text-[var(--muted)]">{t.description}</p>
              </button>
            ))}
          </div>
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={!title.trim() || saving} onClick={() => onCreate(title.trim(), template)}>
            {saving ? "Creating…" : "Create document"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function UploadModal({
  open,
  onClose,
  onUpload,
  uploading,
}: {
  open: boolean;
  onClose: () => void;
  onUpload: (files: File[]) => void;
  uploading: boolean;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) setFiles([]);
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title="Upload files">
      <div className="space-y-4">
        <p className="text-[13px] text-[var(--muted)]">Upload files to the selected folder.</p>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            setFiles((prev) => [...prev, ...Array.from(e.dataTransfer.files)]);
          }}
          onClick={() => inputRef.current?.click()}
          className={`cursor-pointer rounded-[10px] border-2 border-dashed p-8 text-center transition-colors ${
            dragOver ? "border-[var(--brand-primary)] bg-[var(--brand-soft)]" : "border-[var(--border)]"
          }`}
        >
          <IconUpload size={24} className="mx-auto mb-2 text-[var(--muted-soft)]" />
          <p className="text-[13px] text-[var(--muted)]">Drag and drop files here, or click to browse</p>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => setFiles((prev) => [...prev, ...Array.from(e.target.files || [])])}
          />
        </div>
        {files.length > 0 && (
          <ul className="max-h-40 space-y-1 overflow-y-auto text-[13px]">
            {files.map((f, i) => (
              <li key={i} className="flex items-center justify-between rounded bg-[var(--surface-secondary)] px-2 py-1">
                <span className="truncate">{f.name}</span>
                <button type="button" onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}>
                  <IconX size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={files.length === 0 || uploading} onClick={() => onUpload(files)}>
            {uploading ? "Uploading…" : "Upload"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────

function KnowledgeBasePageInner() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.id as string;
  const folderParam = searchParams.get("folder");
  const appliedFolderParam = useRef<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [tree, setTree] = useState<KnowledgeFolderTreeNode | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [breadcrumb, setBreadcrumb] = useState<KnowledgeBreadcrumbEntry[]>([]);
  const [folderName, setFolderName] = useState("");
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<KnowledgeItem[] | null>(null);

  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [createFolderParent, setCreateFolderParent] = useState<string | null>(null);
  const [createDocOpen, setCreateDocOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<KnowledgeFolderTreeNode | null>(null);
  const [moveTarget, setMoveTarget] = useState<{ kind: "folder" | "document" | "file"; id: string; excludeId?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const loadTree = useCallback(async () => {
    const root = await getKnowledgeFolderTree(projectId);
    setTree(root);
    return root;
  }, [projectId]);

  const loadFolder = useCallback(
    async (folderId: string) => {
      setItemsLoading(true);
      try {
        const data = await listKnowledgeFolderItems(projectId, folderId);
        setItems(data.items);
        setBreadcrumb(data.folder.breadcrumb);
        setFolderName(data.folder.isRoot ? "Knowledge base" : data.folder.name);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load folder contents.");
      } finally {
        setItemsLoading(false);
      }
    },
    [projectId]
  );

  useEffect(() => {
    (async () => {
      const me = await authMe();
      if (!me) {
        router.replace("/login");
        return;
      }
      try {
        const root = await loadTree();
        const initialFolderId = folderParam || root.id;
        appliedFolderParam.current = folderParam;
        setSelectedFolderId(initialFolderId);
        const ancestors = findAncestorIds(root, initialFolderId) || [];
        if (ancestors.length) setExpanded((prev) => new Set([...prev, ...ancestors]));
        await loadFolder(initialFolderId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load knowledge base.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the selected folder in sync with the URL, so links from elsewhere (e.g. a
  // document's "Back to folder") and the browser's back/forward buttons work correctly.
  useEffect(() => {
    if (loading || !tree) return;
    const targetFolderId = folderParam || tree.id;
    if (targetFolderId === appliedFolderParam.current) return;
    appliedFolderParam.current = folderParam;
    setSelectedFolderId(targetFolderId);
    setSearchQuery("");
    setSearchInput("");
    const ancestors = findAncestorIds(tree, targetFolderId) || [];
    if (ancestors.length) setExpanded((prev) => new Set([...prev, ...ancestors]));
    void loadFolder(targetFolderId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderParam, loading, tree]);

  useEffect(() => {
    if (!searchQuery) {
      setSearchResults(null);
      return;
    }
    (async () => {
      const data = await searchKnowledgeBase(projectId, { q: searchQuery }).catch(() => ({ list: [], total: 0 }));
      setSearchResults(data.list);
    })();
  }, [searchQuery, projectId]);

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectFolder(id: string) {
    appliedFolderParam.current = id;
    setSelectedFolderId(id);
    setSearchQuery("");
    setSearchInput("");
    void loadFolder(id);
    router.push(`/projects/${projectId}/knowledge-base?folder=${id}`, { scroll: false });
  }

  async function refresh() {
    await loadTree();
    if (selectedFolderId) await loadFolder(selectedFolderId);
  }

  async function handleCreateFolder(name: string, description: string) {
    setSaving(true);
    setError(null);
    try {
      await createKnowledgeFolder(projectId, { name, description: description || undefined, parentFolderId: createFolderParent || selectedFolderId || undefined });
      setCreateFolderOpen(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create folder.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRenameFolder(name: string) {
    if (!renameTarget) return;
    setSaving(true);
    setError(null);
    try {
      await updateKnowledgeFolder(projectId, renameTarget.id, { name });
      setRenameTarget(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename folder.");
    } finally {
      setSaving(false);
    }
  }

  async function handleFolderAction(action: "create-subfolder" | "rename" | "move" | "delete", folder: KnowledgeFolderTreeNode) {
    if (action === "create-subfolder") {
      setCreateFolderParent(folder.id);
      setCreateFolderOpen(true);
    } else if (action === "rename") {
      setRenameTarget(folder);
    } else if (action === "move") {
      setMoveTarget({ kind: "folder", id: folder.id, excludeId: folder.id });
    } else if (action === "delete") {
      if (!window.confirm(`This folder contains documents/files. Deleting "${folder.name}" will also move all contents to trash. Continue?`)) return;
      setError(null);
      try {
        await deleteKnowledgeFolder(projectId, folder.id);
        if (selectedFolderId === folder.id) {
          const root = await loadTree();
          selectFolder(root.id);
        } else {
          await refresh();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete folder.");
      }
    }
  }

  async function handleMove(folderId: string) {
    if (!moveTarget) return;
    setSaving(true);
    setError(null);
    try {
      if (moveTarget.kind === "folder") await moveKnowledgeFolder(projectId, moveTarget.id, folderId);
      else if (moveTarget.kind === "document") await moveKnowledgeDocument(projectId, moveTarget.id, folderId);
      else await moveKnowledgeFile(projectId, moveTarget.id, folderId);
      setMoveTarget(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to move item.");
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateDocument(title: string, template: DocumentTemplate) {
    if (!selectedFolderId) return;
    setSaving(true);
    setError(null);
    try {
      const created = await createKnowledgeDocument(projectId, {
        folderId: selectedFolderId,
        title,
        documentType: template.documentType,
        contentJson: template.content || undefined,
      });
      setCreateDocOpen(false);
      router.push(`/projects/${projectId}/knowledge-base/documents/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create document.");
      setSaving(false);
    }
  }

  async function handleUpload(files: File[]) {
    if (!selectedFolderId) return;
    setUploading(true);
    setError(null);
    try {
      await uploadKnowledgeFiles(projectId, selectedFolderId, files);
      setUploadOpen(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  async function handleDuplicateDocument(documentId: string) {
    setError(null);
    try {
      await duplicateKnowledgeDocument(projectId, documentId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to duplicate document.");
    }
  }

  async function handleDeleteItem(item: KnowledgeItem) {
    const label = itemLabel(item);
    if (!window.confirm(`Delete "${label}"? It will be moved to trash.`)) return;
    setError(null);
    try {
      if (item.type === "document") await deleteKnowledgeDocument(projectId, item.id);
      else if (item.type === "file") await deleteKnowledgeFile(projectId, item.id);
      else await deleteKnowledgeFolder(projectId, item.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete item.");
    }
  }

  function openItem(item: KnowledgeItem) {
    if (item.type === "folder") selectFolder(item.id);
    else if (item.type === "document") router.push(`/projects/${projectId}/knowledge-base/documents/${item.id}`);
    else window.open(getKnowledgeFileDownloadUrl(projectId, item.id), "_blank");
  }

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <p className="text-[var(--muted)]">Loading…</p>
      </div>
    );
  }

  const displayItems = searchResults ?? items;

  return (
    <StandardPageLayout
      header={
        <PageHeader
          title="Knowledge base"
          subtitle="Manage project documents, folders, files, and AI memory."
          breadcrumb={
            <div className="flex items-center gap-1.5 text-[13px]">
              <Link href={`/projects/${projectId}`} className="text-[var(--ink-400)] hover:text-[var(--ink-800)]">Projects</Link>
              <span className="text-[var(--ink-300)]">/</span>
              <span>Knowledge base</span>
            </div>
          }
          actions={
            <Menu
              trigger={
                <Button>
                  <IconPlus size={16} /> New
                </Button>
              }
            >
              {(close) => (
                <>
                  <MenuItem onClick={() => { setCreateFolderParent(selectedFolderId); setCreateFolderOpen(true); close(); }}>
                    <IconFolderPlus size={14} /> Create folder
                  </MenuItem>
                  <MenuItem onClick={() => { setCreateDocOpen(true); close(); }}>
                    <IconFileText size={14} /> Create document
                  </MenuItem>
                  <MenuItem onClick={() => { setUploadOpen(true); close(); }}>
                    <IconUpload size={14} /> Upload file
                  </MenuItem>
                </>
              )}
            </Menu>
          }
        />
      }
    >
      <CreateFolderModal open={createFolderOpen} onClose={() => setCreateFolderOpen(false)} onCreate={handleCreateFolder} saving={saving} />
      <CreateDocumentModal open={createDocOpen} onClose={() => setCreateDocOpen(false)} onCreate={handleCreateDocument} saving={saving} />
      <UploadModal open={uploadOpen} onClose={() => setUploadOpen(false)} onUpload={handleUpload} uploading={uploading} />
      <RenameFolderModal
        open={!!renameTarget}
        initialName={renameTarget?.name || ""}
        onClose={() => setRenameTarget(null)}
        onSave={handleRenameFolder}
        saving={saving}
      />
      <MoveModal
        open={!!moveTarget}
        tree={tree}
        excludeId={moveTarget?.excludeId}
        onClose={() => setMoveTarget(null)}
        onMove={handleMove}
        saving={saving}
      />

      {error && (
        <div className="flex items-center justify-between rounded-lg border border-[var(--error)]/30 bg-[var(--error-soft)] px-4 py-2.5 text-sm text-[var(--error)]">
          <span>{error}</span>
          <button onClick={() => setError(null)}><IconX size={16} /></button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]">
        {/* Left panel: folder tree */}
        <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-2">
          {tree && (
            <FolderTreeNodeRow
              node={tree}
              depth={0}
              selectedId={selectedFolderId}
              onSelect={selectFolder}
              onAction={handleFolderAction}
              expanded={expanded}
              toggleExpanded={toggleExpanded}
            />
          )}
        </div>

        {/* Center panel: content table */}
        <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] p-4">
            <div>
              <div className="flex items-center gap-1 text-[12px] text-[var(--muted)]">
                {breadcrumb.map((b, i) => (
                  <span key={b.id} className="flex items-center gap-1">
                    {i > 0 && <span>/</span>}
                    <span>{b.name}</span>
                  </span>
                ))}
              </div>
              <h2 className="text-[16px] font-semibold text-[var(--foreground)]">{folderName}</h2>
              <p className="text-[12px] text-[var(--muted)]">{items.length} item{items.length !== 1 ? "s" : ""}</p>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setSearchQuery(searchInput.trim());
              }}
              className="flex items-center gap-2"
            >
              <div className="relative">
                <IconSearch size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--muted-soft)]" />
                <Input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search knowledge base…"
                  className="w-64 pl-8"
                />
              </div>
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => { setSearchQuery(""); setSearchInput(""); }}
                  className="text-[12px] text-[var(--brand-primary)] hover:underline"
                >
                  Clear
                </button>
              )}
            </form>
          </div>

          {itemsLoading ? (
            <div className="p-10 text-center text-[var(--muted)]">Loading…</div>
          ) : displayItems.length === 0 ? (
            <div className="p-6">
              <EmptyStateBlock
                title={searchQuery ? "No results found" : "No knowledge added yet"}
                description={searchQuery ? "Try a different search term." : "Create folders, documents, and files to organize project knowledge."}
                action={
                  !searchQuery && (
                    <div className="flex justify-center gap-2">
                      <Button variant="secondary" onClick={() => { setCreateFolderParent(selectedFolderId); setCreateFolderOpen(true); }}>Create folder</Button>
                      <Button variant="secondary" onClick={() => setCreateDocOpen(true)}>Create document</Button>
                      <Button variant="secondary" onClick={() => setUploadOpen(true)}>Upload file</Button>
                    </div>
                  )
                }
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-[var(--border)] bg-[var(--surface-secondary)]">
                    <th className="px-4 py-2.5 text-left font-medium text-[var(--muted-soft)]">Name</th>
                    <th className="px-4 py-2.5 text-left font-medium text-[var(--muted-soft)]">Type</th>
                    {searchQuery && <th className="px-4 py-2.5 text-left font-medium text-[var(--muted-soft)]">Folder path</th>}
                    <th className="px-4 py-2.5 text-left font-medium text-[var(--muted-soft)]">Updated by</th>
                    <th className="px-4 py-2.5 text-left font-medium text-[var(--muted-soft)]">Last updated</th>
                    <th className="px-4 py-2.5 text-left font-medium text-[var(--muted-soft)]">Size</th>
                    <th className="px-4 py-2.5 text-right font-medium text-[var(--muted-soft)]">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {displayItems.map((item) => {
                    const isAiMemory = item.type === "document" && (item as { documentType?: string }).documentType === "ai_memory";
                    return (
                      <tr
                        key={`${item.type}-${item.id}`}
                        className="border-b border-[var(--border-subtle)] last:border-0 hover:bg-[var(--surface-secondary)]/40"
                      >
                        <td className="px-4 py-2.5">
                          <button onClick={() => openItem(item)} className="flex items-center gap-2 text-left hover:underline">
                            {itemIcon(item)}
                            <span className="truncate max-w-[280px] font-medium text-[var(--foreground)]">{itemLabel(item)}</span>
                          </button>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <span className="capitalize text-[var(--muted)]">{item.type}</span>
                            {isAiMemory && (
                              <StatusChip tone={aiMemoryTone((item as { status?: string }).status || "draft")} dot>
                                {(item as { status?: string }).status === "approved" ? "Approved" : (item as { status?: string }).status === "rejected" ? "Rejected" : "AI Generated"}
                              </StatusChip>
                            )}
                          </div>
                        </td>
                        {searchQuery && (
                          <td className="px-4 py-2.5 text-[var(--muted)]">
                            {((item as unknown as { breadcrumb?: KnowledgeBreadcrumbEntry[] }).breadcrumb || []).map((b) => b.name).join(" / ")}
                          </td>
                        )}
                        <td className="px-4 py-2.5 text-[var(--muted)]">{(item as { updatedByName?: string }).updatedByName || "—"}</td>
                        <td className="px-4 py-2.5 text-[var(--muted)]">{formatDate((item as { updatedAt: string }).updatedAt)}</td>
                        <td className="px-4 py-2.5 text-[var(--muted)]">{item.type === "file" ? formatFileSize((item as { fileSize?: number }).fileSize) : "—"}</td>
                        <td className="px-4 py-2.5 text-right">
                          <Menu
                            align="right"
                            trigger={
                              <button className="rounded p-1 hover:bg-[var(--surface-tertiary)]"><IconDots size={16} /></button>
                            }
                          >
                            {(close) => (
                              <>
                                <MenuItem onClick={() => { openItem(item); close(); }}>
                                  <IconArrowRight size={14} /> Open
                                </MenuItem>
                                {item.type === "document" && (
                                  <MenuItem onClick={() => { handleDuplicateDocument(item.id); close(); }}>
                                    <IconCopy size={14} /> Duplicate
                                  </MenuItem>
                                )}
                                {item.type === "file" && (
                                  <MenuItem onClick={() => { window.open(getKnowledgeFileDownloadUrl(projectId, item.id), "_blank"); close(); }}>
                                    <IconDownload size={14} /> Download
                                  </MenuItem>
                                )}
                                {item.type !== "folder" && (
                                  <MenuItem onClick={() => { setMoveTarget({ kind: item.type, id: item.id }); close(); }}>
                                    <IconArrowRight size={14} /> Move
                                  </MenuItem>
                                )}
                                <MenuItem danger onClick={() => { handleDeleteItem(item); close(); }}>
                                  <IconTrash size={14} /> Delete
                                </MenuItem>
                              </>
                            )}
                          </Menu>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </StandardPageLayout>
  );
}

export default function KnowledgeBasePage() {
  return (
    <Suspense>
      <KnowledgeBasePageInner />
    </Suspense>
  );
}
