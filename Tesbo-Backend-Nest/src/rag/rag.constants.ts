export const RAG_EMBEDDING_QUEUE = "knowledge-embedding";
export const RAG_EMBEDDING_JOB_NAME = "embed-source";

export const RAG_EMBEDDING_MODEL = "text-embedding-3-small";
export const RAG_EMBEDDING_DIMENSION = 1536;
export const RAG_EMBEDDING_BATCH_SIZE = 96;

// Char-count approximation of tokens (~4 chars/token) — good enough for chunk sizing and
// context-budget trimming, no tokenizer dependency needed.
export const RAG_CHUNK_TARGET_CHARS = 1600;
export const RAG_CHUNK_OVERLAP_CHARS = 240;
export const RAG_CHUNK_MIN_CHARS = 20;
export const RAG_MAX_CHUNKS_PER_SOURCE = 500;

export const RAG_ANN_CANDIDATES = 40;
export const RAG_FTS_CANDIDATES = 20;
export const RAG_RRF_K = 60;
export const RAG_MAX_SOURCES = 8;
export const RAG_CONTEXT_CHAR_BUDGET = 6000;
