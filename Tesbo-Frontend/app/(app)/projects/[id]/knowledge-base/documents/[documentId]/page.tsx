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
  IconMessagePlus,
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
import { DocumentComments } from "@/components/knowledge-base/DocumentComments";

type SaveStatus = "saved" | "saving" | "unsaved";

// Keep in sync with MAX_REQUEST_BODY_SIZE / maxRequestBodySize in Tesbo-Backend-Nest/src/config/app-config.service.ts
const MAX_DOCUMENT_PAYLOAD_BYTES = 20 * 1024 * 1024;

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function documentPayloadSize(payload: { contentJson: JSONContent; contentHtml: string; contentText: string } | null): number {
  if (!payload) return 0;
  return new Blob([JSON.stringify(payload.contentJson), payload.contentHtml, payload.contentText]).size;
}

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

const FLASH_HIGHLIGHT_NAME = "kb-comment-flash";

/** Flattens a container's text nodes so a quote spanning several elements can still be located. */
function textNodeMap(container: HTMLElement): { nodes: Text[]; text: string; starts: number[] } {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  let node = walker.nextNode() as Text | null;
  while (node) {
    starts.push(text.length);
    nodes.push(node);
    text += node.data;
    node = walker.nextNode() as Text | null;
  }
  return { nodes, text, starts };
}

/** Maps an offset in the flattened text back to a (node, offset) pair. */
function locate(map: ReturnType<typeof textNodeMap>, offset: number): { node: Text; offset: number } | null {
  for (let i = map.nodes.length - 1; i >= 0; i -= 1) {
    if (offset >= map.starts[i]) return { node: map.nodes[i], offset: Math.min(offset - map.starts[i], map.nodes[i].data.length) };
  }
  return null;
}

/** The user's current selection, as a quote plus its offsets into the container's text. */
function readSelection(container: HTMLElement): { text: string; start: number; end: number } | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const quote = selection.toString().replace(/\s+/g, " ").trim();
  if (quote.length < 2) return null;

  const before = document.createRange();
  before.selectNodeContents(container);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  return { text: quote.slice(0, 2000), start, end: start + quote.length };
}

/**
 * Scrolls a quoted passage into view and briefly highlights it.
 *
 * Uses the CSS Custom Highlight API rather than wrapping the text in a <mark>: the body is
 * rendered by TipTap, and mutating its DOM would desync the editor. Where the API is missing the
 * passage still scrolls into view, just without the flash.
 */
function flashQuote(container: HTMLElement, quote: string, hint: number | null): boolean {
  const map = textNodeMap(container);
  const needle = quote.replace(/\s+/g, " ").trim();
  if (!needle) return false;

  // Prefer the occurrence nearest the stored offset, so repeated phrases resolve to the one that
  // was actually commented on.
  let index = -1;
  if (hint !== null) {
    const from = Math.max(0, hint - needle.length);
    index = map.text.indexOf(needle, from);
  }
  if (index === -1) index = map.text.indexOf(needle);
  if (index === -1) return false;

  const from = locate(map, index);
  const to = locate(map, index + needle.length);
  if (!from || !to) return false;

  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);

  const rect = range.getBoundingClientRect();
  window.scrollTo({ top: window.scrollY + rect.top - window.innerHeight / 3, behavior: "smooth" });

  const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const HighlightCtor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (highlights && HighlightCtor) {
    highlights.set(FLASH_HIGHLIGHT_NAME, new HighlightCtor(range));
    setTimeout(() => highlights.delete(FLASH_HIGHLIGHT_NAME), 2000);
  }
  return true;
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
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // The selection captured by the floating "Comment" button, handed to DocumentComments as the
  // anchor for the next thread.
  const [pendingAnchor, setPendingAnchor] = useState<{ text: string; start: number; end: number } | null>(null);
  const [selectionBubble, setSelectionBubble] = useState<{ top: number; left: number } | null>(null);
  const [anchorMissMessage, setAnchorMissMessage] = useState<string | null>(null);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestContent = useRef<{ contentJson: JSONContent; contentHtml: string; contentText: string } | null>(null);

  useEffect(() => {
    (async () => {
      const me = await authMe();
      if (!me) {
        router.replace("/login");
        return;
      }
      setCurrentUserId(me.userId);
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

  useEffect(() => {
    if (!menuOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  // Offers "Comment" whenever there's a selection inside the document body. Bound to selection
  // end (mouseup/keyup) rather than `selectionchange`, which fires on every extend of a drag.
  useEffect(() => {
    function onSelectionEnd() {
      const container = bodyRef.current;
      if (!container) return;
      const selected = readSelection(container);
      if (!selected) {
        setSelectionBubble(null);
        return;
      }
      const range = window.getSelection()?.getRangeAt(0);
      if (!range) return;
      const rect = range.getBoundingClientRect();
      const hostRect = container.getBoundingClientRect();
      setSelectionBubble({ top: rect.top - hostRect.top - 40, left: Math.max(0, rect.left - hostRect.left) });
    }
    document.addEventListener("mouseup", onSelectionEnd);
    document.addEventListener("keyup", onSelectionEnd);
    return () => {
      document.removeEventListener("mouseup", onSelectionEnd);
      document.removeEventListener("keyup", onSelectionEnd);
    };
  }, []);

  function captureSelection() {
    const container = bodyRef.current;
    if (!container) return;
    const selected = readSelection(container);
    if (!selected) return;
    setPendingAnchor(selected);
    setSelectionBubble(null);
    window.getSelection()?.removeAllRanges();
    document.getElementById("kb-comments")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function jumpToAnchor(anchorText: string) {
    const container = bodyRef.current;
    if (!container) return;
    const found = flashQuote(container, anchorText, null);
    // A re-synced body can drop the passage a comment was anchored to. Say so rather than
    // silently doing nothing.
    setAnchorMissMessage(found ? null : "That passage is no longer in this document — it was probably changed by a later sync.");
    if (found) setAnchorMissMessage(null);
  }

  const scheduleSave = useCallback(
    (nextTitle: string) => {
      setSaveStatus("unsaved");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        const payload = latestContent.current;
        const size = documentPayloadSize(payload);
        if (size > MAX_DOCUMENT_PAYLOAD_BYTES) {
          setError(
            `This document is ${formatFileSize(size)}, which is over the ${formatFileSize(MAX_DOCUMENT_PAYLOAD_BYTES)} limit we currently support. Split it into smaller documents to save.`
          );
          setSaveStatus("unsaved");
          return;
        }
        setSaveStatus("saving");
        try {
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
    const payload = latestContent.current;
    const size = documentPayloadSize(payload);
    if (size > MAX_DOCUMENT_PAYLOAD_BYTES) {
      setError(
        `This document is ${formatFileSize(size)}, which is over the ${formatFileSize(MAX_DOCUMENT_PAYLOAD_BYTES)} limit we currently support. Split it into smaller documents to save.`
      );
      setSaveStatus("unsaved");
      return;
    }
    setSaveStatus("saving");
    try {
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
  // Provider mirrors are rewritten wholesale by each sync, so the editor is locked and the API
  // rejects updates. Comments are the writable channel — they're stored apart from the body.
  const isSyncedMirror = doc.isReadOnly && doc.sourceRole === "mirror";
  const providerLabel = doc.sourceProvider === "linear" ? "Linear" : "Jira";

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
          readOnly={isSyncedMirror}
          className={`!h-auto flex-1 border-0 !bg-transparent px-0 text-[26px] font-semibold shadow-none focus:ring-0 ${
            isSyncedMirror ? "cursor-default" : ""
          }`}
          placeholder="Untitled document"
        />
        <div className="flex shrink-0 items-center gap-2">
          {isSyncedMirror && (
            <StatusChip tone="info" dot>
              Synced from {providerLabel}
            </StatusChip>
          )}
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
          {!isSyncedMirror && (
            <span className="text-[12px] text-[var(--muted-soft)]">
              {saveStatus === "saving" ? "Saving…" : saveStatus === "unsaved" ? "Unsaved changes" : "Saved"}
            </span>
          )}
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
          {!isSyncedMirror && (
            <Button variant="secondary" size="sm" onClick={handleManualSave}>Save</Button>
          )}
        </div>
      </div>

      {/* The "why does this document look like this?" banner: what wrote it, who ran that sync,
          when, and where to put your own notes instead. */}
      {isSyncedMirror && (
        <div className="mb-4 rounded-[10px] border border-[var(--border)] bg-[var(--surface-secondary)] px-4 py-3">
          <p className="text-[13px] text-[var(--foreground)]">
            Read-only — this document is written by the {providerLabel} integration and is replaced on every sync.
          </p>
          <p className="mt-1 text-[12px] text-[var(--muted)]">
            {doc.syncedByName ? `Last synced by ${doc.syncedByName}` : "Last synced"}
            {doc.sourceSyncedAt ? ` on ${new Date(doc.sourceSyncedAt).toLocaleString()}` : ""}
            {". "}
            The body is read-only, but comments are not — select any passage to comment on it, or{" "}
            <button
              type="button"
              onClick={() => document.getElementById("kb-comments")?.scrollIntoView({ behavior: "smooth", block: "start" })}
              className="text-[var(--brand-primary)] underline hover:no-underline"
            >
              add a comment below
            </button>
            . Comments are stored separately, so a sync never overwrites them.
          </p>
          {doc.sourceUrl && (
            <a
              href={doc.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-[var(--brand-primary)] hover:underline"
            >
              Open in {providerLabel} <IconArrowRight size={13} />
            </a>
          )}
        </div>
      )}

      {isAiMemory && canApprove && doc.status !== "approved" && doc.status !== "rejected" && (
        <div className="mb-4 flex items-center justify-between rounded-[10px] border border-[var(--ai-border)] bg-[var(--ai-soft)] px-4 py-3">
          <p className="text-[13px] text-[var(--ai-primary)]">This is AI-generated memory. Review before it&apos;s trusted as context.</p>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={handleReject}><IconX size={14} /> Reject</Button>
            <Button size="sm" onClick={handleApprove}><IconCheck size={14} /> Approve</Button>
          </div>
        </div>
      )}

      {anchorMissMessage && (
        <div className="mb-3 flex items-center justify-between rounded-lg border border-[var(--warning)]/30 bg-[var(--warning-soft)] px-4 py-2.5 text-[13px] text-[var(--warning)]">
          <span>{anchorMissMessage}</span>
          <button onClick={() => setAnchorMissMessage(null)}><IconX size={15} /></button>
        </div>
      )}

      <div ref={bodyRef} className="relative">
        {selectionBubble && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={captureSelection}
            style={{ top: selectionBubble.top, left: selectionBubble.left }}
            className="absolute z-20 inline-flex items-center gap-1.5 rounded-[6px] border border-[var(--border)] bg-[var(--surface-overlay)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--foreground)] shadow-[var(--shadow-elevated)] hover:bg-[var(--surface-secondary)]"
          >
            <IconMessagePlus size={14} /> Comment
          </button>
        )}
        <RichTextEditor
          contentJson={doc.contentJson as JSONContent | null}
          contentHtml={doc.contentHtml}
          editable={!isSyncedMirror}
          onUpdate={handleEditorUpdate}
        />
      </div>

      <div id="kb-comments">
        <DocumentComments
          projectId={projectId}
          documentId={documentId}
          currentUserId={currentUserId}
          canModerate={canApprove}
          pendingAnchor={pendingAnchor}
          onAnchorConsumed={() => setPendingAnchor(null)}
          onAnchorClick={jumpToAnchor}
        />
      </div>

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
