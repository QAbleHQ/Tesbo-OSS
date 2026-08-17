/*
 * In-memory upload bodies for the attachment suites.
 *
 * Built as FormData + Buffer rather than from files on disk: both upload endpoints take a repeated
 * `files` field (FilesInterceptor("files", 10)), which a plain multipart object can't express, and
 * every interesting case here is a shape rather than a real document — a zero-byte file, a name that
 * tries to escape the upload directory, a 255-character name, a content type that contradicts the
 * extension. Committing binaries for those would hide the very detail each test is about.
 */

export interface UploadFile {
  name: string;
  mimeType: string;
  body: Buffer;
}

/** The smallest valid PNG: a single transparent pixel. Real bytes, so image handling is genuine. */
export const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

export function pngFile(name = "evidence.png"): UploadFile {
  return { name, mimeType: "image/png", body: PNG_1PX };
}

export function textFile(name = "notes.txt", contents = "e2e attachment contents"): UploadFile {
  return { name, mimeType: "text/plain", body: Buffer.from(contents, "utf-8") };
}

/**
 * A PNG with a valid header and a corrupt image payload — the shape a decoder rejects.
 *
 * Used to drive the failure path of anything that tries to READ an uploaded image rather than just
 * store it (the knowledge base runs OCR over png/jpg on upload). A truncated download, a partial
 * paste, or an image edited by a tool that miscomputed a chunk CRC all arrive looking like this, so
 * it is an ordinary input rather than a hostile one — which is exactly why the server must survive
 * it. See KBF-A-26.
 */
export function corruptPngFile(name = "corrupt.png"): UploadFile {
  const body = Buffer.from(PNG_1PX);
  // The IHDR chunk is left intact so the file is recognised as a PNG and reaches the decoder; the
  // tail (IDAT payload and its CRC) is overwritten so decoding it fails.
  body.fill(0x00, body.length - 12, body.length - 4);
  return { name, mimeType: "image/png", body };
}

/** A file of exactly `bytes` length, for the size and storage-accounting cases. */
export function sizedFile(name: string, bytes: number, mimeType = "application/octet-stream"): UploadFile {
  return { name, mimeType, body: Buffer.alloc(bytes, 0x61) };
}

/**
 * Wraps files as the multipart body Playwright will send.
 *
 * The field name is always "files" and repeats once per file, which is what FilesInterceptor
 * expects — Playwright's object form of `multipart` would collapse them to one key.
 */
export function filesForm(files: UploadFile[]): FormData {
  const form = new FormData();
  for (const file of files) {
    form.append("files", new Blob([new Uint8Array(file.body)], { type: file.mimeType }), file.name);
  }
  return form;
}

/**
 * The same body with extra text fields alongside the files.
 *
 * The Knowledge Base upload route reads `folderId` off the multipart body rather than the URL
 * (`body.folderId` in uploadKnowledgeFiles), so its files cannot be sent with filesForm() alone.
 * Fields go first because the destination has to be readable before the file parts are consumed.
 */
export function filesFormWith(fields: Record<string, string>, files: UploadFile[]): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  for (const file of files) {
    form.append("files", new Blob([new Uint8Array(file.body)], { type: file.mimeType }), file.name);
  }
  return form;
}
