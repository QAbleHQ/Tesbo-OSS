import { inflateRawSync } from "node:zlib";

/*
 * A minimal reader for the zip archives the Knowledge Base export produces.
 *
 * Why not just search the raw bytes: entry NAMES appear in the archive as plain text (the central
 * directory stores them uncompressed), so a substring check on the buffer looks like it works — but
 * entry CONTENTS are DEFLATE-compressed, so asserting on them that way silently only ever passes
 * for content that happens to survive compression. That made "the export contains the file's bytes"
 * a test that could not fail for the right reason.
 *
 * Why not a library: adding an archive dependency to the suite for this is more moving parts than
 * the ~40 lines below, and the format's central directory is stable and simple. Only the two
 * compression methods the export actually emits are supported (0 = stored, 8 = deflate); anything
 * else throws rather than returning something plausible.
 */

export interface ZipEntry {
  /** Path inside the archive, with `/` separators — e.g. "Nested/Nested doc.html". */
  name: string;
  contents: Buffer;
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;

/** Every entry in the archive, in central-directory order. */
export function readZipEntries(zip: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);

  const entries: ZipEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    if (zip.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
      throw new Error(`Malformed zip: expected a central directory header at byte ${offset}`);
    }
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString("utf-8", offset + 46, offset + 46 + nameLength);

    // The local header repeats the name and extra-field lengths, and they can differ from the
    // central directory's — the payload starts after the LOCAL ones, so they must be read here.
    const localNameLength = zip.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = zip.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const raw = zip.subarray(dataStart, dataStart + compressedSize);

    let contents: Buffer;
    if (method === 0) contents = Buffer.from(raw);
    else if (method === 8) contents = inflateRawSync(raw);
    else throw new Error(`Unsupported zip compression method ${method} for entry "${name}"`);

    entries.push({ name, contents });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The entry names only, for asserting on an archive's structure. */
export function zipEntryNames(zip: Buffer): string[] {
  return readZipEntries(zip).map((e) => e.name);
}

/** One entry's contents as UTF-8, or null when the archive has no such entry. */
export function zipEntryText(zip: Buffer, name: string): string | null {
  const entry = readZipEntries(zip).find((e) => e.name === name);
  return entry ? entry.contents.toString("utf-8") : null;
}

/**
 * The end-of-central-directory record, searched from the back.
 *
 * It is the last thing in the file apart from an optional trailing comment, and the signature can
 * legitimately appear inside compressed data, so scanning forwards would find the wrong one.
 */
function findEndOfCentralDirectory(zip: Buffer): number {
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY) return i;
  }
  throw new Error("Not a zip archive: no end-of-central-directory record found");
}
