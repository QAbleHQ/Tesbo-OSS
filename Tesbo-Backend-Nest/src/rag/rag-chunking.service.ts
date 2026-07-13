import { Injectable } from "@nestjs/common";
import { RAG_CHUNK_MIN_CHARS, RAG_CHUNK_OVERLAP_CHARS, RAG_CHUNK_TARGET_CHARS, RAG_MAX_CHUNKS_PER_SOURCE } from "./rag.constants";
import { RagChunk } from "./rag.types";

interface Section {
  headingPath: string | null;
  text: string;
}

// Pure text -> chunks. No DB/network calls, so this is trivially unit-testable and safe to
// call synchronously inside the embedding processor.
@Injectable()
export class RagChunkingService {
  chunk(rawText: string): RagChunk[] {
    const text = String(rawText || "").trim();
    if (!text) return [];

    const sections = this.splitByHeadings(text);
    const chunks: RagChunk[] = [];
    for (const section of sections) {
      for (const piece of this.splitSection(section.text)) {
        if (piece.trim().length < RAG_CHUNK_MIN_CHARS) continue;
        chunks.push({
          chunkIndex: chunks.length,
          headingPath: section.headingPath,
          content: piece.trim(),
          tokenCount: Math.ceil(piece.length / 4)
        });
        if (chunks.length >= RAG_MAX_CHUNKS_PER_SOURCE) return chunks;
      }
    }
    return chunks;
  }

  // Splits on markdown-style heading lines (# .. ######), tracking a breadcrumb of the
  // heading stack so each chunk can cite "Setup > Prerequisites" rather than just a title.
  private splitByHeadings(text: string): Section[] {
    const lines = text.split("\n");
    const headingRe = /^(#{1,6})\s+(.*)$/;
    const stack: string[] = [];
    const sections: Section[] = [];
    let current: string[] = [];

    const flush = () => {
      const body = current.join("\n").trim();
      if (body) sections.push({ headingPath: stack.length ? stack.join(" > ") : null, text: body });
      current = [];
    };

    for (const line of lines) {
      const match = line.match(headingRe);
      if (match) {
        flush();
        const level = match[1].length;
        stack.length = level - 1;
        stack[level - 1] = match[2].trim();
        continue;
      }
      current.push(line);
    }
    flush();

    return sections.length ? sections : [{ headingPath: null, text }];
  }

  // Within a section, recursively splits on a separator cascade (blank line -> newline ->
  // sentence -> hard cut) and re-merges small adjacent pieces up to the target chunk size,
  // with a small overlap between consecutive chunks so context isn't lost at a chunk boundary.
  private splitSection(text: string): string[] {
    const pieces = this.recursiveSplit(text, ["\n\n", "\n", ". "]);
    const merged: string[] = [];
    let buffer = "";

    for (const piece of pieces) {
      const candidate = buffer ? `${buffer}\n${piece}` : piece;
      if (candidate.length <= RAG_CHUNK_TARGET_CHARS || !buffer) {
        buffer = candidate;
      } else {
        merged.push(buffer);
        const overlap = buffer.slice(Math.max(0, buffer.length - RAG_CHUNK_OVERLAP_CHARS));
        buffer = `${overlap}\n${piece}`;
      }
    }
    if (buffer) merged.push(buffer);
    return merged;
  }

  private recursiveSplit(text: string, separators: string[]): string[] {
    if (text.length <= RAG_CHUNK_TARGET_CHARS || separators.length === 0) {
      return this.hardCut(text);
    }
    const [sep, ...rest] = separators;
    const parts = text.split(sep).filter(Boolean);
    if (parts.length <= 1) return this.recursiveSplit(text, rest);
    return parts.flatMap((part) => (part.length > RAG_CHUNK_TARGET_CHARS ? this.recursiveSplit(part, rest) : [part]));
  }

  private hardCut(text: string): string[] {
    if (text.length <= RAG_CHUNK_TARGET_CHARS) return [text];
    const out: string[] = [];
    for (let i = 0; i < text.length; i += RAG_CHUNK_TARGET_CHARS) {
      out.push(text.slice(i, i + RAG_CHUNK_TARGET_CHARS));
    }
    return out;
  }
}
