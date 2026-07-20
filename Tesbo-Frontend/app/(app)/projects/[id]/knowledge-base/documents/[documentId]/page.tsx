"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { JSONContent } from "@tiptap/react";
import {
  IconDots,
  IconArrowLeft,
  IconArrowRight,
  IconCopy,
  IconTrash,
  IconHistory,
  IconLink,
  IconCheck,
  IconX,
} from "@tabler/icons-react";
import {
  authMe,
  listProjectMembers,
  getKnowledgeDocument,
  updateKnowledgeDocument,
  duplicateKnowledgeDocument,
  deleteKnowledgeDocument,
  listKnowledgeDocumentVersions,
  restoreKnowledgeDocumentVersion,
  approveAiMemory,
  rejectAiMemory,
  type KnowledgeDocument,
  type KnowledgeDocumentVersion,
  type KnowledgeBreadcrumbEntry,
} from "@/lib/api";
import { Button, Input, Modal, StatusChip } from "@/components/ui";
import RichTextEditor from "@/components/knowledge-base/RichTextEditor";

type SaveStatus = "saved" | "saving" | "unsaved";

const DOC_TYPE_LABELS: Record<string, string> = {
  general: "General",
  api_note: "API Note",
  release_note: "Release Note",
  requirement_note: "Requirement",
  test_data_note: "Test Data",
};

function normalizeRole(role: string): "owner" | "manager" | "qa_engineer" {
  const n = (role ?? "").trim().toLowerCase().replace(/-/g, "_").replace(/ /g, "_");
  if (n === "owner") return "owner";
  if (n === "manager" || n === "admin" || n === "test_manager") return "manager";
  return "qa_engineer";
}

export default function KnowledgeDocumentPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const documentId = params.documentId as string;

  const [loading, setLoading] = useState(true);
  const [doc, setDoc] = useState<KnowledgeDocument | null>(null);
  const [breadcrumb, setBreadcrumb] = useState<KnowledgeBreadcrumbEntry[]>([]);
  const [title, setTitle] = useState("");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [error, setError] = useState<string | null>(null);
  const [canApprove, setCanApprove] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState<KnowledgeDocumentVersion[]>([]);
  const [linkCopied, setLinkCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestContent = useRef<{ contentJson: JSONContent; contentHtml: string; contentText: string } | null>(null);

  useEffect(() => {
    (async () => {
      const me = await authMe();
      if (!me) {
        router.replace("/login");
        return;
      }
      try {
        const data = await getKnowledgeDocument(projectId, documentId);
        setDoc(data);
        setBreadcrumb(data.breadcrumb);
        setTitle(data.title);
        const members = await listProjectMembers(projectId).catch(() => []);
        const role = normalizeRole(members.find((m) => m.userId === me.userId)?.role ?? "qa_engineer");
        setCanApprove(role === "owner" || role === "manager");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load document.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, documentId]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const scheduleSave = useCallback(
    (nextTitle: string) => {
      setSaveStatus("unsaved");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        setSaveStatus("saving");
        try {
          const payload = latestContent.current;
          const updated = await updateKnowledgeDocument(projectId, documentId, {
            title: nextTitle,
            contentJson: payload?.contentJson,
            contentHtml: payload?.contentHtml,
            contentText: payload?.contentText,
          });
          setDoc(updated);
          setSaveStatus("saved");
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to save document.");
          setSaveStatus("unsaved");
        }
      }, 1200);
    },
    [projectId, documentId]
  );

  function handleEditorUpdate(payload: { json: JSONContent; html: string; text: string }) {
    latestContent.current = { contentJson: payload.json, contentHtml: payload.html, contentText: payload.text };
    scheduleSave(title);
  }

  function handleTitleChange(value: string) {
    setTitle(value);
    scheduleSave(value);
  }

  async function handleManualSave() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveStatus("saving");
    try {
      const payload = latestContent.current;
      const updated = await updateKnowledgeDocument(projectId, documentId, {
        title,
        contentJson: payload?.contentJson,
        contentHtml: payload?.contentHtml,
        contentText: payload?.contentText,
      });
      setDoc(updated);
      setSaveStatus("saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save document.");
      setSaveStatus("unsaved");
    }
  }

  async function handleDuplicate() {
    try {
      const dup = await duplicateKnowledgeDocument(projectId, documentId);
      router.push(`/projects/${projectId}/knowledge-base/documents/${dup.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to duplicate document.");
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete "${title}"? It will be moved to trash.`)) return;
    try {
      await deleteKnowledgeDocument(projectId, documentId);
      router.push(`/projects/${projectId}/knowledge-base`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete document.");
    }
  }

  async function openHistory() {
    setHistoryOpen(true);
    const data = await listKnowledgeDocumentVersions(projectId, documentId).catch(() => ({ list: [], total: 0 }));
    setVersions(data.list);
  }

  async function handleRestoreVersion(versionId: string) {
    try {
      const updated = await updateAfterRestore(versionId);
      setDoc(updated);
      setTitle(updated.title);
      setHistoryOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to restore version.");
    }
  }

  async function updateAfterRestore(versionId: string) {
    return restoreKnowledgeDocumentVersion(projectId, documentId, versionId);
  }

  async function handleApprove() {
    try {
      const updated = await approveAiMemory(projectId, documentId);
      setDoc(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to approve AI memory.");
    }
  }

  async function handleReject() {
    try {
      const updated = await rejectAiMemory(projectId, documentId);
      setDoc(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reject AI memory.");
    }
  }

  function handleCopyLink() {
    navigator.clipboard.writeText(window.location.href).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 1500);
    });
  }

  if (loading || !doc) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <p className="text-[var(--muted)]">Loading…</p>
      </div>
    );
  }

  const isAiMemory = doc.documentType === "ai_memory";

  const parentFolder = breadcrumb[breadcrumb.length - 1];
  const rootFolder = breadcrumb[0];

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 text-[13px] text-[var(--muted)]">
          <Link href={`/projects/${projectId}`} className="hover:text-[var(--foreground)]">Projects</Link>
          <span>/</span>
          <Link
            href={`/projects/${projectId}/knowledge-base${rootFolder ? `?folder=${rootFolder.id}` : ""}`}
            className="hover:text-[var(--foreground)]"
          >
            Knowledge base
          </Link>
          {breadcrumb.slice(1).map((b) => (
            <span key={b.id} className="flex items-center gap-1.5">
              <span>/</span>
              <Link href={`/projects/${projectId}/knowledge-base?folder=${b.id}`} className="hover:text-[var(--foreground)]">
                {b.name}
              </Link>
            </span>
          ))}
          <span>/</span>
          <span className="text-[var(--foreground)]">{title || "Untitled"}</span>
        </div>
        {parentFolder && (
          <Link
            href={`/projects/${projectId}/knowledge-base?folder=${parentFolder.id}`}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-[6px] border border-[var(--border)] px-3 py-1.5 text-[13px] font-medium text-[var(--foreground)] hover:bg-[var(--surface-secondary)]"
          >
            <IconArrowLeft size={14} /> Back to {parentFolder.id === rootFolder?.id ? "Knowledge base" : parentFolder.name}
          </Link>
        )}
      </div>

      {error && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-[var(--error)]/30 bg-[var(--error-soft)] px-4 py-2.5 text-sm text-[var(--error)]">
          <span>{error}</span>
          <button onClick={() => setError(null)}><IconX size={16} /></button>
        </div>
      )}

      <div className="mb-4 flex items-start justify-between gap-4">
        <Input
          value={title}
          onChange={(e) => handleTitleChange(e.target.value)}
          className="!h-auto flex-1 border-0 !bg-transparent px-0 text-[26px] font-semibold shadow-none focus:ring-0"
          placeholder="Untitled document"
        />
        <div className="flex shrink-0 items-center gap-2">
          {isAiMemory && (
            <StatusChip tone={doc.status === "approved" ? "success" : doc.status === "rejected" ? "error" : "draft"} dot>
              {doc.status === "approved" ? "Approved memory" : doc.status === "rejected" ? "Rejected" : "AI Generated"}
            </StatusChip>
          )}
          {!isAiMemory && (
            <span className="rounded-[4px] bg-[var(--surface-secondary)] px-2 py-0.5 font-mono text-[11px] font-medium text-[var(--accent-light)]">
              {DOC_TYPE_LABELS[doc.documentType] || "Document"}
            </span>
          )}
          <span className="text-[12px] text-[var(--muted-soft)]">
            {saveStatus === "saving" ? "Saving…" : saveStatus === "unsaved" ? "Unsaved changes" : "Saved"}
          </span>
          <div className="relative" ref={menuRef}>
            <button onClick={() => setMenuOpen((v) => !v)} className="rounded-[6px] border border-[var(--border)] p-2 hover:bg-[var(--surface-secondary)]">
              <IconDots size={16} />
            </button>
            {menuOpen && (
              <div className="absolute right-0 z-20 mt-1 min-w-[180px] rounded-[8px] border border-[var(--border)] bg-[var(--surface-overlay)] py-1 shadow-[var(--shadow-elevated)]">
                <button onClick={handleDuplicate} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-[var(--surface-secondary)]">
                  <IconCopy size={14} /> Duplicate
                </button>
                <button onClick={openHistory} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-[var(--surface-secondary)]">
                  <IconHistory size={14} /> View history
                </button>
                <button onClick={handleCopyLink} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-[var(--surface-secondary)]">
                  <IconLink size={14} /> {linkCopied ? "Copied!" : "Copy link"}
                </button>
                <button onClick={handleDelete} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-[var(--error)] hover:bg-[var(--error-soft)]">
                  <IconTrash size={14} /> Delete
                </button>
              </div>
            )}
          </div>
          <Button variant="secondary" size="sm" onClick={handleManualSave}>Save</Button>
        </div>
      </div>

      {isAiMemory && canApprove && doc.status !== "approved" && doc.status !== "rejected" && (
        <div className="mb-4 flex items-center justify-between rounded-[10px] border border-[var(--ai-border)] bg-[var(--ai-soft)] px-4 py-3">
          <p className="text-[13px] text-[var(--ai-primary)]">This is AI-generated memory. Review before it&apos;s trusted as context.</p>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={handleReject}><IconX size={14} /> Reject</Button>
            <Button size="sm" onClick={handleApprove}><IconCheck size={14} /> Approve</Button>
          </div>
        </div>
      )}

      <RichTextEditor contentJson={doc.contentJson as JSONContent | null} contentHtml={doc.contentHtml} onUpdate={handleEditorUpdate} />

      <Modal open={historyOpen} onClose={() => setHistoryOpen(false)} title="Version history">
        {versions.length === 0 ? (
          <p className="text-[13px] text-[var(--muted)]">No earlier versions yet.</p>
        ) : (
          <ul className="max-h-80 space-y-2 overflow-y-auto">
            {versions.map((v) => (
              <li key={v.id} className="flex items-center justify-between rounded-[8px] border border-[var(--border)] px-3 py-2">
                <div>
                  <p className="text-[13px] font-medium">{v.title}</p>
                  <p className="text-[12px] text-[var(--muted)]">Version {v.versionNumber} — {new Date(v.createdAt).toLocaleString()}</p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => handleRestoreVersion(v.id)}>
                  <IconArrowRight size={14} /> Restore
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </div>
  );
}
