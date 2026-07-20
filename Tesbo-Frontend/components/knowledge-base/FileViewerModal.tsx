"use client";

import { useEffect, useState } from "react";
import { IconDownload, IconFileText, IconX } from "@tabler/icons-react";
import { Button, Modal } from "@/components/ui";
import { getKnowledgeFileDownloadUrl, getKnowledgeFilePreviewUrl, type KnowledgeFile } from "@/lib/api";
import { getFileViewerKind } from "@/lib/fileViewer";

type ViewableFile = Pick<KnowledgeFile, "id" | "originalFileName" | "fileExtension">;

type FileViewerModalProps = {
  projectId: string;
  file: ViewableFile | null;
  onClose: () => void;
};

export default function FileViewerModal({ projectId, file, onClose }: FileViewerModalProps) {
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const [textLoading, setTextLoading] = useState(false);

  const kind = file ? getFileViewerKind(file.fileExtension) : "unsupported";
  const previewUrl = file ? getKnowledgeFilePreviewUrl(projectId, file.id) : "";
  const downloadUrl = file ? getKnowledgeFileDownloadUrl(projectId, file.id) : "";

  useEffect(() => {
    if (!file || kind !== "text") {
      setTextContent(null);
      setTextError(null);
      return;
    }
    let cancelled = false;
    setTextLoading(true);
    setTextContent(null);
    setTextError(null);
    fetch(previewUrl, { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load file preview.");
        return res.text();
      })
      .then((text) => {
        if (!cancelled) setTextContent(text);
      })
      .catch((err) => {
        if (!cancelled) setTextError(err instanceof Error ? err.message : "Failed to load file preview.");
      })
      .finally(() => {
        if (!cancelled) setTextLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id, kind]);

  return (
    <Modal open={!!file} onClose={onClose} className="max-w-4xl">
      {file && (
        <div className="flex h-[75vh] flex-col">
          <div className="mb-4 flex shrink-0 items-center justify-between gap-3">
            <h2 className="truncate text-[18px] font-semibold leading-[1.2] tracking-[-0.02em] text-[var(--ink-800)]">
              {file.originalFileName}
            </h2>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => window.open(downloadUrl, "_blank")}>
                <IconDownload size={14} /> Download
              </Button>
              <button
                onClick={onClose}
                className="rounded p-1.5 text-[var(--ink-400)] hover:bg-[var(--ink-100)] hover:text-[var(--ink-600)]"
              >
                <IconX size={16} />
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto rounded-[8px] border border-[var(--border)] bg-[var(--surface-secondary)]">
            {kind === "image" && (
              <div className="flex h-full items-center justify-center p-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={previewUrl} alt={file.originalFileName} className="max-h-full max-w-full object-contain" />
              </div>
            )}

            {kind === "pdf" && <iframe src={previewUrl} title={file.originalFileName} className="h-full w-full" />}

            {kind === "video" && (
              <div className="flex h-full items-center justify-center p-4">
                <video src={previewUrl} controls className="max-h-full max-w-full" />
              </div>
            )}

            {kind === "audio" && (
              <div className="flex h-full items-center justify-center p-6">
                <audio src={previewUrl} controls className="w-full max-w-md" />
              </div>
            )}

            {kind === "text" && (
              <div className="h-full overflow-auto p-4">
                {textLoading && <p className="text-[13px] text-[var(--muted)]">Loading preview…</p>}
                {textError && <p className="text-[13px] text-[var(--error)]">{textError}</p>}
                {textContent !== null && (
                  <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.5] text-[var(--foreground)]">
                    {textContent}
                  </pre>
                )}
              </div>
            )}

            {kind === "unsupported" && (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                <IconFileText size={32} className="text-[var(--ink-300)]" />
                <p className="text-[13px] text-[var(--muted)]">Preview isn&apos;t available for this file type.</p>
                <Button size="sm" onClick={() => window.open(downloadUrl, "_blank")}>
                  <IconDownload size={14} /> Download file
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
