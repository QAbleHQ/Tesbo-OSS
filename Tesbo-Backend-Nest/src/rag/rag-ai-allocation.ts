import { DatabaseService } from "../database/database.service";

export interface EmbeddingKeyAllocation {
  provider: string;
  api_key: string;
  base_url: string | null;
  auth_header_name: string | null;
  auth_scheme: string | null;
  is_active: boolean;
}

// Reuses the same project_ai_key_allocations -> workspace_ai_keys join as
// LegacyService.zyraAiAllocation, but only ever returns a key when its provider supports
// embeddings. Anthropic has no embeddings endpoint, so an Anthropic-only allocation resolves
// to null here — callers should treat that as "RAG unsupported for this project", not an
// error, and fall back to keyword/full-text search.
export async function resolveEmbeddingAllocation(db: DatabaseService, projectId: string): Promise<EmbeddingKeyAllocation | null> {
  const res = await db.query<EmbeddingKeyAllocation>(
    `SELECT k.provider, k.api_key, k.base_url, k.auth_header_name, k.auth_scheme, k.is_active
     FROM project_ai_key_allocations a
     JOIN workspace_ai_keys k ON k.id = a.workspace_ai_key_id
     WHERE a.project_id = $1`,
    [projectId]
  );
  const key = res.rows[0];
  if (!key || !key.is_active || String(key.provider || "").toLowerCase() !== "openai") return null;
  return key;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

export function normalizeEmbeddingsUrl(baseUrl?: string | null): string {
  const value = String(baseUrl || "").trim();
  if (!value) return "https://api.openai.com/v1/embeddings";
  const trimmed = trimTrailingSlashes(value);
  if (trimmed.endsWith("/embeddings")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/embeddings`;
  return `${trimmed}/v1/embeddings`;
}

export async function embedTexts(allocation: EmbeddingKeyAllocation, inputs: string[], model: string): Promise<number[][]> {
  const authHeader = String(allocation.auth_header_name || "Authorization");
  const scheme = String(allocation.auth_scheme || "Bearer").trim();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  headers[authHeader] = scheme ? `${scheme} ${allocation.api_key}` : String(allocation.api_key);

  const res = await fetch(normalizeEmbeddingsUrl(allocation.base_url), {
    method: "POST",
    headers,
    body: JSON.stringify({ model, input: inputs })
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: { message?: string } | string };
    const rawMessage = typeof errBody.error === "string" ? errBody.error : errBody.error?.message || String(res.status);
    throw new Error(rawMessage);
  }
  const data = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
  return data.data.sort((a, b) => a.index - b.index).map((row) => row.embedding);
}
