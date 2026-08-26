export const RAG_EMBEDDING_QUEUE = "knowledge-embedding";
export const RAG_EMBEDDING_JOB_NAME = "embed-source";

// The platform-wide vector width. Every embeddings-capable provider must emit exactly this,
// either natively or via the OpenAI `dimensions` parameter — pgvector cannot index mixed
// widths in one column, and the HNSW index in V55/V85 is declared at this size.
//
// 1024 rather than OpenAI's native 1536 because it is the only width every candidate provider
// can produce: mistral-embed and the self-hosted open models are natively 1024 and cannot be
// widened, while text-embedding-3-small and gemini-embedding-001 reduce to it natively.
// See V85_embedding_dimension_1024.sql for the full reasoning.
export const RAG_EMBEDDING_DIMENSION = 1024;
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
