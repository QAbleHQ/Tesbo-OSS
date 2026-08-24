// Mirrors the backend rules in Tesbo-Backend-Nest/src/common/person-name.util.ts and
// Tesbo-Backend-Nest/src/auth/password.service.ts (assertValidPassword) — keep both in sync.

export const NAME_MAX_LENGTH = 100;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const EMAIL_MAX_LENGTH = 255;

export const PASSWORD_RULES_HINT = `At least ${PASSWORD_MIN_LENGTH} characters, with an uppercase letter, a lowercase letter, and a number.`;

// Unicode letters/marks so accented and non-Latin names aren't rejected, plus the
// punctuation real names use: space, hyphen, apostrophe, period (e.g. "Jr.").
const NAME_CHARS_RE = /^[\p{L}\p{M} '.-]+$/u;

export function validateName(value: string, fieldLabel = "Name"): string | null {
  const trimmed = value.trim();
  if (!trimmed) return `${fieldLabel} is required`;
  if (trimmed.length > NAME_MAX_LENGTH) return `${fieldLabel} must be at most ${NAME_MAX_LENGTH} characters`;
  if (!NAME_CHARS_RE.test(trimmed)) {
    return `${fieldLabel} can only contain letters, spaces, hyphens, apostrophes, and periods`;
  }
  return null;
}

export function validatePasswordValue(value: string): string | null {
  if (value.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (value.length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  if (!/[a-z]/.test(value)) return "Password must include at least one lowercase letter";
  if (!/[A-Z]/.test(value)) return "Password must include at least one uppercase letter";
  if (!/[0-9]/.test(value)) return "Password must include at least one number";
  return null;
}

export function validateEmailValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Email is required";
  if (trimmed.length > EMAIL_MAX_LENGTH) return `Email must be at most ${EMAIL_MAX_LENGTH} characters`;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return "Enter a valid email address";
  return null;
}

// Mirrors Tesbo-Backend-Nest/src/legacy/legacy.service.ts (createProject / updateProject).
// PROJECT_NAME_MAX_LENGTH matches the projects.name VARCHAR(255) column — going over that
// isn't just a policy choice, the insert/update would otherwise fail outright.
export const PROJECT_NAME_MIN_LENGTH = 3;
export const PROJECT_NAME_MAX_LENGTH = 255;
export const PROJECT_DESCRIPTION_MAX_LENGTH = 500;

export function validateProjectName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "Project name is required";
  if (trimmed.length < PROJECT_NAME_MIN_LENGTH) return `Project name must be at least ${PROJECT_NAME_MIN_LENGTH} characters`;
  if (trimmed.length > PROJECT_NAME_MAX_LENGTH) return `Project name must be at most ${PROJECT_NAME_MAX_LENGTH} characters`;
  return "";
}

export function validateProjectDescription(value: string): string {
  if (value.trim().length > PROJECT_DESCRIPTION_MAX_LENGTH) {
    return `Description must be at most ${PROJECT_DESCRIPTION_MAX_LENGTH} characters`;
  }
  return "";
}

// Mirrors Tesbo-Backend-Nest/src/legacy/legacy.service.ts — LegacyService.KB_ALLOWED_EXTENSIONS,
// the FilesInterceptor("files", 10, ...) file-count limit, and KB_MAX_UPLOAD_SIZE (itself driven
// by the MAX_UPLOAD_SIZE env var, currently 50MB). Keep all three in sync with the backend.
// Archives (zip) and executables (exe) are deliberately excluded — a zip can hide anything,
// including an executable, past this extension check.
export const KB_ALLOWED_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "webp", "svg",
  "pdf", "doc", "docx", "txt", "md",
  "xls", "xlsx", "csv",
  "ppt", "pptx",
  "js", "ts", "java", "py", "json", "xml", "yaml", "yml", "sql", "html", "css",
  "mp3", "wav", "m4a",
  "mp4", "mov", "webm"
]);
export const KB_MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
export const KB_MAX_FILES_PER_UPLOAD = 10;
export const KB_ACCEPT_ATTR = [...KB_ALLOWED_EXTENSIONS].map((ext) => `.${ext}`).join(",");
export const KB_UPLOAD_HINT =
  `Images, PDF, Word/Excel/PowerPoint, code/text files, or audio/video (no zip or executable files) · Max ${KB_MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB per file · Up to ${KB_MAX_FILES_PER_UPLOAD} files at a time`;

function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
}

/** Validates one file to upload to the knowledge base. Returns an error message, or null if valid. */
export function validateKnowledgeBaseFile(file: File): string | null {
  const ext = fileExtension(file.name);
  if (!ext || !KB_ALLOWED_EXTENSIONS.has(ext)) {
    return `${file.name}: this file type is not supported`;
  }
  if (file.size > KB_MAX_FILE_SIZE_BYTES) {
    return `${file.name}: file is too large (max ${KB_MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB)`;
  }
  return null;
}

// Mirrors Tesbo-Backend-Nest/migrations/V45_knowledge_base_v2.sql — knowledge_documents.title is
// VARCHAR(512), and legacy.service.ts (createKnowledgeDocument / updateKnowledgeDocument) enforces
// the same limit server-side.
export const KB_DOCUMENT_TITLE_MAX_LENGTH = 512;

/** Validates a knowledge base document title. Returns an error message, or null if valid. */
export function validateKnowledgeDocumentTitle(title: string): string | null {
  if (title.trim().length > KB_DOCUMENT_TITLE_MAX_LENGTH) {
    return `Title must be at most ${KB_DOCUMENT_TITLE_MAX_LENGTH} characters`;
  }
  return null;
}

// Mirrors Tesbo-Backend-Nest/src/legacy/legacy.service.ts (LegacyService.KB_FOLDER_NAME_MAX_LENGTH,
// enforced in createKnowledgeFolder / updateKnowledgeFolder). A product-level cap, tighter than the
// knowledge_folders.name VARCHAR(255) column — folder names render in narrow tree/breadcrumb UI.
export const KB_FOLDER_NAME_MAX_LENGTH = 50;

/** Validates a knowledge base folder name. Returns an error message, or null if valid. */
export function validateKnowledgeFolderName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Folder name is required";
  if (trimmed.length > KB_FOLDER_NAME_MAX_LENGTH) return `Folder name must be at most ${KB_FOLDER_NAME_MAX_LENGTH} characters`;
  return null;
}

/**
 * localStorage key marking a document as created from the "Blank document" template, so the
 * editor can require both a title and content instead of the usual title-or-content rule.
 * Set at creation time (knowledge-base/page.tsx) and read in the document editor.
 */
export function blankDocumentFlagKey(documentId: string): string {
  return `kb-blank-doc:${documentId}`;
}

// Mirrors Tesbo-Backend-Nest/src/legacy/legacy.service.ts — KB_ALLOWED_EXTENSIONS and
// EVIDENCE_MAX_FILE_SIZE / assertValidEvidenceFiles — keep both in sync. The server is still the
// authority; this copy exists so a rejected file is named the moment it is picked, instead of after
// a full upload that the modal used to swallow silently (Basecamp 10226296533).
export const EVIDENCE_ALLOWED_EXTENSIONS = [
  "png", "jpg", "jpeg", "webp", "svg",
  "pdf", "doc", "docx", "txt", "md",
  "xls", "xlsx", "csv",
  "ppt", "pptx",
  "js", "ts", "java", "py", "json", "xml", "yaml", "yml", "sql", "html", "css",
  "mp3", "wav", "m4a",
  "mp4", "mov", "webm",
];

export const EVIDENCE_MAX_FILE_SIZE = 25 * 1024 * 1024;

// The picker's `accept` list. Advisory only — a viewer can always switch the dialog to "All files",
// which is why validateEvidenceFile still runs on everything that comes back.
export const EVIDENCE_ACCEPT_ATTRIBUTE = EVIDENCE_ALLOWED_EXTENSIONS.map((ext) => `.${ext}`).join(",");

export function formatFileSizeShort(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

export function validateEvidenceFile(file: { name: string; size: number }): string | null {
  const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  if (!ext) return `${file.name} has no file extension, so its type can't be determined.`;
  if (!EVIDENCE_ALLOWED_EXTENSIONS.includes(ext)) return `${file.name}: .${ext} files aren't supported.`;
  if (file.size <= 0) return `${file.name} is empty (0 bytes).`;
  if (file.size > EVIDENCE_MAX_FILE_SIZE) {
    return `${file.name} is ${formatFileSizeShort(file.size)}, which is over the ${formatFileSizeShort(EVIDENCE_MAX_FILE_SIZE)} limit.`;
  }
  return null;
}
