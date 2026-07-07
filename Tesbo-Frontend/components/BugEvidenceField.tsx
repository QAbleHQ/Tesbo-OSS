"use client";

import { useRef } from "react";
import { Button, Field, FieldLabel, Input } from "@/components/ui";
import type { BugAttachment } from "@/lib/api";

export type EvidenceMode = "FILES" | "BETTERBUGS";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface Props {
  mode: EvidenceMode;
  onModeChange: (m: EvidenceMode) => void;
  stagedFiles: File[];
  onStagedFilesChange: (files: File[]) => void;
  existingAttachments?: BugAttachment[];
  onRemoveExisting?: (attachmentId: string) => void;
  downloadUrl?: (attachmentId: string) => string;
  betterbugsUrl: string;
  onBetterbugsUrlChange: (v: string) => void;
}

// Either/or: a bug points at raw file evidence OR an existing BetterBugs session — BetterBugs
// sessions already carry screenshots/console logs/steps, so re-attaching files on top is redundant.
export default function BugEvidenceField({
  mode,
  onModeChange,
  stagedFiles,
  onStagedFilesChange,
  existingAttachments,
  onRemoveExisting,
  downloadUrl,
  betterbugsUrl,
  onBetterbugsUrlChange,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  function addFiles(files: FileList | null) {
    if (!files || !files.length) return;
    onStagedFilesChange([...stagedFiles, ...Array.from(files)]);
  }

  function removeStagedFile(index: number) {
    onStagedFilesChange(stagedFiles.filter((_, i) => i !== index));
  }

  return (
    <Field>
      <FieldLabel>Evidence</FieldLabel>
      <div className="flex flex-wrap gap-2 mb-2">
        <Button type="button" size="sm" variant={mode === "FILES" ? "primary" : "secondary"} onClick={() => onModeChange("FILES")}>
          Attach Files
        </Button>
        <Button type="button" size="sm" variant={mode === "BETTERBUGS" ? "primary" : "secondary"} onClick={() => onModeChange("BETTERBUGS")}>
          BetterBugs Link
        </Button>
      </div>

      {mode === "FILES" ? (
        <div className="space-y-2">
          {existingAttachments && existingAttachments.length > 0 && (
            <ul className="space-y-1">
              {existingAttachments.map((att) => (
                <li
                  key={att.id}
                  className="flex items-center justify-between rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-1.5 text-[13px]"
                >
                  {downloadUrl ? (
                    <a href={downloadUrl(att.id)} target="_blank" rel="noreferrer" className="text-[var(--brand-primary)] hover:underline truncate">
                      {att.fileName}
                    </a>
                  ) : (
                    <span className="truncate">{att.fileName}</span>
                  )}
                  <span className="flex items-center gap-2 shrink-0">
                    <span className="text-[var(--muted)]">{formatFileSize(att.fileSize)}</span>
                    {onRemoveExisting && (
                      <button type="button" onClick={() => onRemoveExisting(att.id)} className="text-[var(--muted)] hover:text-[var(--error)]">
                        ✕
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {stagedFiles.length > 0 && (
            <ul className="space-y-1">
              {stagedFiles.map((file, index) => (
                <li
                  key={`${file.name}-${index}`}
                  className="flex items-center justify-between rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-1.5 text-[13px]"
                >
                  <span className="truncate">{file.name}</span>
                  <span className="flex items-center gap-2 shrink-0">
                    <span className="text-[var(--muted)]">{formatFileSize(file.size)}</span>
                    <button type="button" onClick={() => removeStagedFile(index)} className="text-[var(--muted)] hover:text-[var(--error)]">
                      ✕
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <Button type="button" variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
            + Add files
          </Button>
        </div>
      ) : (
        <Input
          type="url"
          value={betterbugsUrl}
          onChange={(e) => onBetterbugsUrlChange(e.target.value)}
          placeholder="https://app.betterbugs.io/session/…"
        />
      )}
    </Field>
  );
}
