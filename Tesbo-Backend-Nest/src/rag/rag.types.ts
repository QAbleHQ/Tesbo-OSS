export type RagSourceType = "document" | "file";

export interface EmbeddingJobPayload {
  organizationId: string;
  projectId: string;
  sourceType: RagSourceType;
  sourceId: string;
  reason: "created" | "updated" | "transcribed" | "reindex";
}

export interface RagChunk {
  chunkIndex: number;
  headingPath: string | null;
  content: string;
  tokenCount: number;
}

export interface RetrievedKnowledgeItem {
  title: string;
  content: string;
  citation: { sourceType: RagSourceType; sourceId: string; headingPath: string | null };
  score: number;
}
