export type FileViewerKind = "image" | "pdf" | "video" | "audio" | "text" | "unsupported";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "svg"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a"]);
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "csv",
  "js", "ts", "java", "py", "json", "xml", "yaml", "yml", "sql", "html", "css",
]);

export function getFileViewerKind(extension: string | null | undefined): FileViewerKind {
  const ext = (extension || "").toLowerCase().replace(/^\./, "");
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return "unsupported";
}
