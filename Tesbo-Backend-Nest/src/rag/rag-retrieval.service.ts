import { Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { embedTexts, resolveEmbeddingAllocation } from "./rag-ai-allocation";
import {
  RAG_ANN_CANDIDATES,
  RAG_CONTEXT_CHAR_BUDGET,
  RAG_EMBEDDING_MODEL,
  RAG_FTS_CANDIDATES,
  RAG_MAX_SOURCES,
  RAG_RRF_K
} from "./rag.constants";
import { RagSourceType, RetrievedKnowledgeItem } from "./rag.types";

interface AnnRow {
  source_type: RagSourceType;
  source_id: string;
  heading_path: string | null;
  content: string;
  title: string;
  cosine_similarity: number;
}

interface FtsRow {
  source_type: RagSourceType;
  source_id: string;
  title: string;
  content: string;
  rank: number;
}

interface FusedSource {
  key: string;
  sourceType: RagSourceType;
  sourceId: string;
  title: string;
  score: number;
  chunks: Array<{ content: string; headingPath: string | null }>;
}

// Additive semantic retrieval for Zyra's free-text chat path. Does NOT replace
// knowledgeSnapshot() (that stays for the explicit-picker task-generation flow — a
// named-document lookup, not semantic search). Never throws: any failure (no embedding
// allocation, nothing embedded yet, embeddings API error) resolves to [] so the caller's
// existing knowledgeSnapshot() fallback stays clean.
@Injectable()
export class RagRetrievalService {
  private readonly logger = new Logger(RagRetrievalService.name);

  constructor(private readonly db: DatabaseService) {}

  async retrieveKnowledgeContext(projectId: string, query: string, opts: { maxSources?: number; charBudget?: number } = {}): Promise<RetrievedKnowledgeItem[]> {
    try {
      const text = String(query || "").trim();
      if (!text) return [];

      const allocation = await resolveEmbeddingAllocation(this.db, projectId);
      const [annRows, ftsDocRows, ftsFileRows] = await Promise.all([
        allocation ? this.annSearch(projectId, allocation, text) : Promise.resolve([] as AnnRow[]),
        this.ftsSearch(projectId, "knowledge_documents", "content_text", text),
        this.ftsSearch(projectId, "knowledge_files", "extracted_text", text)
      ]);
      if (!annRows.length && !ftsDocRows.length && !ftsFileRows.length) return [];

      const fused = this.fuse(annRows, [...ftsDocRows, ...ftsFileRows]);
      return this.budgetToItems(fused, opts.maxSources ?? RAG_MAX_SOURCES, opts.charBudget ?? RAG_CONTEXT_CHAR_BUDGET);
    } catch (err) {
      this.logger.warn(`retrieveKnowledgeContext failed for project ${projectId}: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  private async annSearch(projectId: string, allocation: NonNullable<Awaited<ReturnType<typeof resolveEmbeddingAllocation>>>, query: string): Promise<AnnRow[]> {
    const [queryVector] = await embedTexts(allocation, [query], RAG_EMBEDDING_MODEL);
    if (!queryVector) return [];
    const vectorLiteral = `[${queryVector.join(",")}]`;
    // The literal `c.project_id = $1` equality is what lets Postgres prune straight to one
    // of the 64 hash partitions before touching that partition's HNSW index.
    const res = await this.db.query<AnnRow>(
      `SELECT c.source_type, c.source_id, c.heading_path, c.content,
              COALESCE(d.title, f.original_file_name) AS title,
              1 - (c.embedding <=> $2::vector) AS cosine_similarity
       FROM knowledge_document_chunks c
       LEFT JOIN knowledge_documents d ON c.source_type = 'document' AND d.id = c.source_id
         AND d.is_deleted = false AND (d.document_type != 'ai_memory' OR d.status = 'approved')
       LEFT JOIN knowledge_files f ON c.source_type = 'file' AND f.id = c.source_id AND f.is_deleted = false
       WHERE c.project_id = $1 AND (d.id IS NOT NULL OR f.id IS NOT NULL)
       ORDER BY c.embedding <=> $2::vector
       LIMIT ${RAG_ANN_CANDIDATES}`,
      [projectId, vectorLiteral]
    );
    return res.rows;
  }

  private async ftsSearch(projectId: string, table: "knowledge_documents" | "knowledge_files", contentColumn: string, query: string): Promise<FtsRow[]> {
    const titleColumn = table === "knowledge_documents" ? "title" : "original_file_name";
    const approvalFilter = table === "knowledge_documents" ? "AND (document_type != 'ai_memory' OR status = 'approved')" : "";
    const sourceType: RagSourceType = table === "knowledge_documents" ? "document" : "file";
    const res = await this.db
      .query<{ id: string; title: string; content: string; rank: number }>(
        `SELECT id, ${titleColumn} AS title, ${contentColumn} AS content, ts_rank(search_vector, plainto_tsquery('english', $2)) AS rank
         FROM ${table}
         WHERE project_id = $1 AND is_deleted = false ${approvalFilter}
           AND search_vector @@ plainto_tsquery('english', $2)
         ORDER BY rank DESC LIMIT ${RAG_FTS_CANDIDATES}`,
        [projectId, query]
      )
      .catch(() => ({ rows: [] as Array<{ id: string; title: string; content: string; rank: number }> }));
    return res.rows.map((row) => ({ source_type: sourceType, source_id: row.id, title: row.title, content: row.content, rank: row.rank }));
  }

  // Reciprocal rank fusion in application code (not SQL — ANN rows are chunk-level, FTS rows
  // are document-level, so reconciling in a UNION/CTE would be messier than a few lines here).
  private fuse(annRows: AnnRow[], ftsRows: FtsRow[]): FusedSource[] {
    const bySource = new Map<string, FusedSource>();

    const annRanked = [...annRows].sort((a, b) => b.cosine_similarity - a.cosine_similarity);
    annRanked.forEach((row, rank) => {
      const key = `${row.source_type}:${row.source_id}`;
      const existing = bySource.get(key) || { key, sourceType: row.source_type, sourceId: row.source_id, title: row.title, score: 0, chunks: [] };
      existing.score += 1 / (RAG_RRF_K + rank + 1);
      existing.chunks.push({ content: row.content, headingPath: row.heading_path });
      bySource.set(key, existing);
    });

    ftsRows.forEach((row, rank) => {
      const key = `${row.source_type}:${row.source_id}`;
      const existing = bySource.get(key) || { key, sourceType: row.source_type, sourceId: row.source_id, title: row.title, score: 0, chunks: [] };
      existing.score += 1 / (RAG_RRF_K + rank + 1);
      if (!existing.chunks.length) existing.chunks.push({ content: row.content.slice(0, 1500), headingPath: null });
      bySource.set(key, existing);
    });

    return Array.from(bySource.values()).sort((a, b) => b.score - a.score);
  }

  private budgetToItems(fused: FusedSource[], maxSources: number, charBudget: number): RetrievedKnowledgeItem[] {
    const items: RetrievedKnowledgeItem[] = [];
    let used = 0;
    for (const source of fused.slice(0, maxSources)) {
      const content = source.chunks.map((c) => c.content).join("\n...\n");
      if (used >= charBudget) break;
      const remaining = charBudget - used;
      const trimmed = content.length > remaining ? `${content.slice(0, remaining)}...` : content;
      used += trimmed.length;
      items.push({
        title: source.title || "Untitled",
        content: trimmed,
        citation: { sourceType: source.sourceType, sourceId: source.sourceId, headingPath: source.chunks[0]?.headingPath ?? null },
        score: source.score
      });
    }
    return items;
  }
}
