"use client";

import { useRef, useState } from "react";
import { Button, Field, FieldLabel, Input } from "@/components/ui";
import type { BugAttachment } from "@/lib/api";
import {
  EVIDENCE_ACCEPT_ATTRIBUTE,
  EVIDENCE_ALLOWED_EXTENSIONS,
  EVIDENCE_MAX_FILE_SIZE,
  formatFileSizeShort,
  validateEvidenceFile,
} from "@/lib/validation";

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
  const [rejections, setRejections] = useState<string[]>([]);

  /*
   * Files are checked as they are picked, not on submit.
   *
   * Basecamp 10226296533: an unsupported or oversized file was staged silently, uploaded in full,
   * and rejected by the server with nothing shown — the save button just sat on "Saving…". Naming
   * the offending file here means the person never gets that far. Valid files in the same selection
   * are still staged; only the rejects are dropped, so picking five files and getting one wrong
   * doesn't discard the other four.
   */
  function addFiles(files: FileList | null) {
    if (!files || !files.length) return;
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const file of Array.from(files)) {
      const problem = validateEvidenceFile(file);
      if (problem) rejected.push(problem);
      else accepted.push(file);
    }
    setRejections(rejected);
    if (accepted.length) onStagedFilesChange([...stagedFiles, ...accepted]);
  }

  function removeStagedFile(index: number) {
    setRejections([]);
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
                    <a href={downloadUrl(att.id)} target="_blank" rel="noreferrer" className="text-[var(--accent-light)] hover:underline truncate">
                      {att.fileName}
                    </a>
                  ) : (
                    <span className="truncate">{att.fileName}</span>
                  )}
                  <span className="flex items-center gap-2 shrink-0">
                    <span className="text-[var(--muted)]">{formatFileSize(att.fileSize)}</span>
                    {onRemoveExisting && (
                      <button type="button" onClick={() => onRemoveExisting(att.id)} className="text-[var(--muted)] hover:text-[var(--error-foreground)]">
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
                    <button type="button" onClick={() => removeStagedFile(index)} className="text-[var(--muted)] hover:text-[var(--error-foreground)]">
                      ✕
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {rejections.length > 0 && (
            <ul data-testid="evidence-rejections" className="space-y-1">
              {rejections.map((message) => (
                <li
                  key={message}
                  className="rounded-[var(--radius-control)] border border-[var(--error)] bg-[var(--error)]/10 px-3 py-1.5 text-[13px] text-[var(--error-foreground)]"
                >
                  {message}
                </li>
              ))}
            </ul>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={EVIDENCE_ACCEPT_ATTRIBUTE}
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
              + Add files
            </Button>
            <span className="text-[12px] text-[var(--muted)]">
              Up to {formatFileSizeShort(EVIDENCE_MAX_FILE_SIZE)} per file · {EVIDENCE_ALLOWED_EXTENSIONS.length} supported types
            </span>
          </div>
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
