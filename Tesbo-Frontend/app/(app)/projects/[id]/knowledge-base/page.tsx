"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  IconFolder,
  IconFileText,
  IconFile,
  IconChevronRight,
  IconDots,
  IconPlus,
  IconSearch,
  IconUpload,
  IconTrash,
  IconFolderPlus,
  IconArrowRight,
  IconCopy,
  IconDownload,
  IconX,
  IconFolders,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
} from "@tabler/icons-react";
import {
  authMe,
  getProject,
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
  getKnowledgeBaseSummary,
  getKnowledgeFolderExportUrl,
  type KnowledgeFolderTreeNode,
  type KnowledgeItem,
  type KnowledgeBreadcrumbEntry,
  type KnowledgeFile,
  type KnowledgeBaseSummary,
} from "@/lib/api";
import { Button, Input, Modal, Field, FieldLabel, StatusChip, EmptyStateBlock } from "@/components/ui";
import { useTopBarSlots } from "@/components/TopBarSlots";
import FileViewerModal from "@/components/knowledge-base/FileViewerModal";
import { Menu, MenuItem } from "@/components/knowledge-base/Menu";
import { FolderTreeNodeRow, flattenFolders, findAncestorIds, type FolderAction } from "@/components/knowledge-base/FolderTree";

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;
type TypeFilter = "all" | "folder" | "document" | "file";
type SortOption = "updated" | "name" | "size";

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

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Mirrors what TipTap's getText()/getHTML() would produce for the small set of node types
// used by DOCUMENT_TEMPLATES below, so a freshly created document has real contentHtml/contentText
// (searchable, and visible to Zyra) instead of relying on the user to type something first.
function docNodeToText(node: DocNode | null | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.text || "";
  const parts: string[] = (node.content || []).map(docNodeToText);
  if (node.type === "listItem") return parts.join(" ");
  return parts.join(node.type === "doc" || node.type === "bulletList" ? "\n" : "");
}

function docNodeToHtml(node: DocNode | null | undefined): string {
  if (!node) return "";
  if (node.type === "text") return escapeHtml(node.text || "");
  const inner = (node.content || []).map(docNodeToHtml).join("");
  const level = node.attrs?.level || 1;
  switch (node.type) {
    case "doc": return inner;
    case "heading": return `<h${level}>${inner}</h${level}>`;
    case "paragraph": return `<p>${inner}</p>`;
    case "bulletList": return `<ul>${inner}</ul>`;
    case "listItem": return `<li>${inner}</li>`;
    default: return inner;
  }
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
  uploadProgress,
}: {
  open: boolean;
  onClose: () => void;
  onUpload: (files: File[]) => void;
  uploading: boolean;
  uploadProgress: { done: number; total: number } | null;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const pickerOpenRef = useRef(false);
  useEffect(() => {
    if (open) setFiles([]);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const clearPickerOpen = () => { pickerOpenRef.current = false; };
    window.addEventListener("focus", clearPickerOpen);
    return () => window.removeEventListener("focus", clearPickerOpen);
  }, [open]);

  function openFilePicker() {
    if (pickerOpenRef.current) return;
    pickerOpenRef.current = true;
    inputRef.current?.click();
  }

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
          onClick={openFilePicker}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openFilePicker();
            }
          }}
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
        {uploading && uploadProgress && uploadProgress.total > 1 && (
          <p className="text-[13px] text-[var(--muted)]">
            Uploading {uploadProgress.done} of {uploadProgress.total} files…
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={uploading}>Cancel</Button>
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

  // Take over the shared TopBar with this page's breadcrumb + actions (portaled below),
  // and hide the default global "Search projects" search while this page is mounted.
  const { startEl: topBarStartEl, endEl: topBarEndEl, setFilled: setTopBarFilled } = useTopBarSlots();
  useEffect(() => {
    setTopBarFilled(true);
    return () => setTopBarFilled(false);
  }, [setTopBarFilled]);

  const [loading, setLoading] = useState(true);
  const [projectName, setProjectName] = useState("");
  const [summary, setSummary] = useState<KnowledgeBaseSummary | null>(null);
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
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [sortBy, setSortBy] = useState<SortOption>("updated");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);

  const [treePanelOpen, setTreePanelOpen] = useState(true);

  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [createFolderParent, setCreateFolderParent] = useState<string | null>(null);
  const [createDocOpen, setCreateDocOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<KnowledgeFolderTreeNode | null>(null);
  const [moveTarget, setMoveTarget] = useState<{ kind: "folder" | "document" | "file"; id: string; excludeId?: string } | null>(null);
  const [viewerFile, setViewerFile] = useState<KnowledgeItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);

  const loadTree = useCallback(async () => {
    const root = await getKnowledgeFolderTree(projectId);
    setTree(root);
    return root;
  }, [projectId]);

  const loadSummary = useCallback(async () => {
    const data = await getKnowledgeBaseSummary(projectId).catch(() => null);
    setSummary(data);
  }, [projectId]);

  const loadFolder = useCallback(
    async (folderId: string) => {
      setItemsLoading(true);
      try {
        const data = await listKnowledgeFolderItems(projectId, folderId);
        setItems(data.items);
        setBreadcrumb(data.folder.breadcrumb);
        setFolderName(data.folder.isRoot ? "Knowledge base" : data.folder.name);
        setPage(1);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load folder contents.");
      } finally {
        setItemsLoading(false);
      }
    },
    [projectId]
  );

  useEffect(() => {
    const savedPanel = localStorage.getItem("tesbo_kb_tree_panel");
    if (savedPanel === "closed") setTreePanelOpen(false);
    (async () => {
      const me = await authMe();
      if (!me) {
        router.replace("/login");
        return;
      }
      try {
        const [project, root] = await Promise.all([getProject(projectId), loadTree()]);
        setProjectName(String(project.name || ""));
        void loadSummary();
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
      setPage(1);
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

  function toggleTreePanel() {
    setTreePanelOpen((prev) => {
      const next = !prev;
      localStorage.setItem("tesbo_kb_tree_panel", next ? "open" : "closed");
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
    await Promise.all([loadTree(), selectedFolderId ? loadFolder(selectedFolderId) : Promise.resolve(), loadSummary()]);
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

  async function handleFolderAction(action: FolderAction, folder: KnowledgeFolderTreeNode) {
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
        contentHtml: template.content ? docNodeToHtml(template.content) : undefined,
        contentText: template.content ? docNodeToText(template.content) : undefined,
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
    setUploadProgress({ done: 0, total: files.length });
    try {
      await uploadKnowledgeFiles(projectId, selectedFolderId, files, (done, total) =>
        setUploadProgress({ done, total })
      );
      setUploadOpen(false);
      await refresh();
    } catch (err) {
      // Earlier batches may have already been persisted before this one failed, so
      // refresh to reflect the files that did make it in before surfacing the error.
      await refresh();
      setError(err instanceof Error ? err.message : "Upload failed. Please try again.");
    } finally {
      setUploading(false);
      setUploadProgress(null);
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
    else setViewerFile(item);
  }

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <p className="text-[var(--muted)]">Loading…</p>
      </div>
    );
  }

  const baseItems = searchResults ?? items;
  const typeFilteredItems = typeFilter === "all" ? baseItems : baseItems.filter((item) => item.type === typeFilter);
  const sortedItems = [...typeFilteredItems].sort((a, b) => {
    if (sortBy === "name") return itemLabel(a).localeCompare(itemLabel(b));
    if (sortBy === "size") {
      const sizeOf = (item: KnowledgeItem) => (item.type === "file" ? Number((item as { fileSize?: number }).fileSize || 0) : -1);
      return sizeOf(b) - sizeOf(a);
    }
    return new Date((b as { updatedAt: string }).updatedAt).getTime() - new Date((a as { updatedAt: string }).updatedAt).getTime();
  });
  const totalItems = sortedItems.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedItems = sortedItems.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    // Full-bleed, full-height IDE-style workspace, same convention as the Test Case
    // repository / Plan Details / Project Settings screens (`tc-fullbleed` makes the
    // wrapping .tesbo-page drop its centered 1280px cap + padding).
    <main className="tc-fullbleed flex flex-col pb-4 pr-4 pt-4" style={{ height: "calc(100vh - 3.5rem)" }}>
      <div className="flex min-h-0 flex-1 flex-col">
        {topBarStartEl &&
          createPortal(
            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[12px]">
              {projectName && (
                <>
                  <button
                    type="button"
                    onClick={() => router.push("/projects")}
                    className="truncate text-[var(--muted-soft)] transition-colors hover:text-[var(--brand-primary)]"
                  >
                    {projectName}
                  </button>
                  <IconChevronRight size={12} stroke={1.75} className="shrink-0 text-[var(--muted-soft)]" />
                </>
              )}
              <span className="font-medium text-[var(--brand-primary)]">Knowledge base</span>
            </nav>,
            topBarStartEl
          )}
        {topBarEndEl &&
          createPortal(
            <div className="flex flex-wrap items-center gap-2">
              {selectedFolderId && (
                <a
                  href={getKnowledgeFolderExportUrl(projectId, selectedFolderId)}
                  className="flex h-[30px] items-center gap-1.5 rounded-[6px] border border-[var(--ink-200)] bg-transparent px-3 text-[12px] font-medium text-[var(--ink-600)] transition-colors hover:bg-[var(--ink-100)]"
                >
                  <IconDownload size={13} stroke={1.75} />
                  Export
                </a>
              )}
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
            </div>,
            topBarEndEl
          )}

        <CreateFolderModal open={createFolderOpen} onClose={() => setCreateFolderOpen(false)} onCreate={handleCreateFolder} saving={saving} />
        <CreateDocumentModal open={createDocOpen} onClose={() => setCreateDocOpen(false)} onCreate={handleCreateDocument} saving={saving} />
        <UploadModal
          open={uploadOpen}
          onClose={() => { if (!uploading) setUploadOpen(false); }}
          onUpload={handleUpload}
          uploading={uploading}
          uploadProgress={uploadProgress}
        />
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
        <FileViewerModal
          projectId={projectId}
          file={viewerFile && viewerFile.type === "file" ? (viewerFile as unknown as KnowledgeFile) : null}
          onClose={() => setViewerFile(null)}
        />

        {/* Title + stats row */}
        <div className="mb-3 flex shrink-0 flex-wrap items-start justify-between gap-4 pl-4">
          <div>
            <h1 className="text-[20px] font-semibold leading-tight tracking-[-0.02em] text-[var(--foreground)]">
              Knowledge base
            </h1>
            <p className="mt-[3px] text-[13px] text-[var(--muted-soft)]">
              {summary ? `${summary.total} item${summary.total === 1 ? "" : "s"} across ${summary.folders} folder${summary.folders === 1 ? "" : "s"}` : "Manage project documents, folders, files, and AI memory."}
            </p>
          </div>
          {summary && (
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              <div className="rounded-[7px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-center">
                <div className="text-[16px] font-semibold leading-tight tracking-tight text-[var(--foreground)]">{summary.total}</div>
                <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Total</div>
              </div>
              <div className="rounded-[7px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-center">
                <div className="text-[16px] font-semibold leading-tight tracking-tight text-[var(--brand-primary)]">{summary.folders}</div>
                <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Folders</div>
              </div>
              <div className="rounded-[7px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-center">
                <div className="text-[16px] font-semibold leading-tight tracking-tight text-[var(--info)]">{summary.documents}</div>
                <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Docs</div>
              </div>
              <div className="rounded-[7px] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-center">
                <div className="text-[16px] font-semibold leading-tight tracking-tight text-[var(--muted)]">{summary.files}</div>
                <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--muted-soft)]">Files</div>
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="mb-3 flex shrink-0 items-center justify-between rounded-lg border border-[var(--error)]/30 bg-[var(--error-soft)] px-4 py-2.5 text-sm text-[var(--error)]">
            <span>{error}</span>
            <button onClick={() => setError(null)}><IconX size={16} /></button>
          </div>
        )}

        <div className="flex min-h-0 flex-1 overflow-hidden rounded-r-xl border border-l-0 border-[var(--border)] bg-[var(--surface)]">
          {/* ── Folder tree panel ── */}
          <aside className={`flex shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] transition-[width] duration-150 ${treePanelOpen ? "w-[260px]" : "w-[38px]"}`}>
            <nav className="flex min-h-0 flex-1 flex-col">
              <div className={`flex h-10 shrink-0 items-center border-b border-[var(--border)] px-3 ${treePanelOpen ? "justify-between" : "justify-center"}`}>
                {treePanelOpen && (
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--ink-600)]">
                    <IconFolders size={14} stroke={1.75} className="text-[var(--brand-primary)]" />
                    Folders
                    {summary && (
                      <span className="rounded-full bg-[var(--brand-soft)] px-1.5 py-px font-mono text-[10px] font-normal normal-case text-[var(--brand-primary)]">
                        {summary.folders}
                      </span>
                    )}
                  </p>
                )}
                <div className="flex items-center gap-0.5">
                  {treePanelOpen && (
                    <button
                      type="button"
                      title="New folder"
                      onClick={() => { setCreateFolderParent(selectedFolderId); setCreateFolderOpen(true); }}
                      className="flex h-6 w-6 items-center justify-center rounded text-[var(--muted)] transition-colors hover:bg-[var(--brand-soft)] hover:text-[var(--brand-primary)]"
                    >
                      <IconPlus size={14} stroke={2.5} />
                    </button>
                  )}
                  <button
                    type="button"
                    title={treePanelOpen ? "Collapse folders" : "Show folders"}
                    onClick={toggleTreePanel}
                    className="flex h-6 w-6 items-center justify-center rounded text-[var(--muted)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--foreground)]"
                  >
                    {treePanelOpen ? (
                      <IconLayoutSidebarLeftCollapse size={14} stroke={1.75} />
                    ) : (
                      <IconLayoutSidebarLeftExpand size={14} stroke={1.75} />
                    )}
                  </button>
                </div>
              </div>
              {treePanelOpen && (
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
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
                  <button
                    type="button"
                    onClick={() => { setCreateFolderParent(selectedFolderId); setCreateFolderOpen(true); }}
                    className="mt-2 flex w-full items-center gap-1.5 rounded-[6px] border border-dashed border-[var(--border)] px-3 py-1.5 text-[12px] text-[var(--muted)] transition-colors hover:border-[var(--brand-primary)] hover:bg-[var(--brand-soft)] hover:text-[var(--brand-primary)]"
                  >
                    <IconPlus size={13} stroke={2} /> New folder
                  </button>
                </div>
              )}
            </nav>
          </aside>

          {/* ── Content panel ── */}
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Folder breadcrumb + name + count */}
            <div className="shrink-0 border-b border-[var(--border)] px-4 py-3">
              <div className="flex items-center gap-1 text-[12px] text-[var(--muted)]">
                {breadcrumb.map((b, i) => (
                  <span key={b.id} className="flex items-center gap-1">
                    {i > 0 && <span>/</span>}
                    <span>{b.name}</span>
                  </span>
                ))}
              </div>
              <h2 className="text-[15px] font-semibold text-[var(--foreground)]">{folderName}</h2>
              <p className="text-[12px] text-[var(--muted)]">{items.length} item{items.length !== 1 ? "s" : ""}</p>
            </div>

            {/* Filter bar */}
            <div className="flex min-h-[48px] shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-2">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setSearchQuery(searchInput.trim());
                }}
                className="flex min-w-[200px] max-w-[300px] flex-1 items-center gap-2"
              >
                <div className="relative w-full">
                  <IconSearch size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--muted-soft)]" />
                  <Input
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    placeholder="Search knowledge base…"
                    className="w-full pl-8"
                  />
                </div>
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => { setSearchQuery(""); setSearchInput(""); }}
                    className="shrink-0 text-[12px] text-[var(--brand-primary)] hover:underline"
                  >
                    Clear
                  </button>
                )}
              </form>
              <div className="ml-auto flex items-center gap-1.5">
                <select
                  value={typeFilter}
                  onChange={(e) => { setTypeFilter(e.target.value as TypeFilter); setPage(1); }}
                  className="h-[30px] rounded-[6px] border border-[var(--border)] bg-[var(--background)] px-2.5 text-[12px] text-[var(--ink-600)] outline-none"
                >
                  <option value="all">All types</option>
                  <option value="folder">Folder</option>
                  <option value="document">Document</option>
                  <option value="file">File</option>
                </select>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as SortOption)}
                  className="h-[30px] rounded-[6px] border border-[var(--border)] bg-[var(--background)] px-2.5 text-[12px] text-[var(--ink-600)] outline-none"
                >
                  <option value="updated">Sort: Updated</option>
                  <option value="name">Sort: Name</option>
                  <option value="size">Sort: Size</option>
                </select>
              </div>
            </div>

            {/* Table */}
            {itemsLoading ? (
              <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-[var(--muted)]">Loading…</div>
            ) : pagedItems.length === 0 ? (
              <div className="flex min-h-0 flex-1 items-center justify-center p-6">
                <EmptyStateBlock
                  title={searchQuery ? "No results found" : totalItems === 0 && typeFilter === "all" ? "No knowledge added yet" : "No items match your filters"}
                  description={
                    searchQuery
                      ? "Try a different search term."
                      : totalItems === 0 && typeFilter === "all"
                        ? "Create folders, documents, and files to organize project knowledge."
                        : "Try a different type filter."
                  }
                  action={
                    !searchQuery && totalItems === 0 && typeFilter === "all" && (
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
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="w-full text-[13px]">
                  <thead className="sticky top-0 z-[1]">
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
                    {pagedItems.map((item) => {
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

            {/* Pagination footer */}
            {!itemsLoading && totalItems > 0 && (
              <div className="flex h-11 shrink-0 items-center justify-between border-t border-[var(--border)] bg-[var(--surface)] px-4 text-[12px]">
                <span className="text-[var(--muted)]">
                  <span className="font-medium text-[var(--foreground)]">{totalItems}</span> {totalItems === 1 ? "result" : "results"}
                  {totalPages > 1 && (
                    <>
                      {" · "}page <span className="font-medium text-[var(--foreground)]">{safePage}</span> of{" "}
                      <span className="font-medium text-[var(--foreground)]">{totalPages}</span>
                    </>
                  )}
                </span>
                <div className="flex items-center gap-2">
                  <select
                    value={pageSize}
                    onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
                    className="h-7 rounded-[5px] border border-[var(--border)] bg-[var(--background)] px-2 text-[12px] text-[var(--ink-600)] outline-none"
                  >
                    {PAGE_SIZE_OPTIONS.map((n) => (
                      <option key={n} value={n}>{n} / page</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                    disabled={safePage === 1}
                    className="rounded-[5px] border border-[var(--border)] px-3 py-1 text-[12px] text-[var(--muted)] hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] disabled:pointer-events-none disabled:opacity-50"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={() => setPage((prev) => (prev >= totalPages ? prev : prev + 1))}
                    disabled={safePage >= totalPages}
                    className="rounded-[5px] border border-[var(--border)] px-3 py-1 text-[12px] text-[var(--muted)] hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] disabled:pointer-events-none disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

export default function KnowledgeBasePage() {
  return (
    <Suspense>
      <KnowledgeBasePageInner />
    </Suspense>
  );
}
