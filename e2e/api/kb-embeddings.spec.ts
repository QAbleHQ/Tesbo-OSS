import { expect, test, type APIRequestContext } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { column, exec, literal, scalar } from "../utils/psql";
import { loginAs, provisionRbacTenant, rbacSuiteSkipReason, type RbacTenant } from "../utils/rbac-tenant";

/*
 * Semantic knowledge-base retrieval — which key produces the vectors, and what happens when none can.
 *
 * The regression this file exists for: knowledge_document_chunks was empty across the ENTIRE
 * production database — every project, every workspace, 1,237 documents and 43 files — and nothing
 * reported it. resolveEmbeddingAllocation() accepted only `openai`, every allocated key in the
 * product is Anthropic (which has no embeddings endpoint), so it returned a bare null; retrieval
 * treats null the same as "nothing relevant found", and rag-embedding.processor.ts recorded the
 * refusal as embedding_status='unsupported' — a TERMINAL status that resumeInterruptedEmbeddings()
 * never revisits. So the outage was silent *and* self-sealing: fixing the allocator alone would
 * have left every existing document permanently dark.
 *
 * Own tenant (not knowledge-base.spec.ts's) because these tests attach and detach workspace AI
 * keys, and api/zyra.spec.ts + api/ai-keys.spec.ts assert on the key set of the tenants they own.
 *
 * The embeddings provider is a local stub rather than a real vendor: a real key would make the
 * suite depend on a paid third party, and the assertions here are about which key gets chosen and
 * what width the vectors are, not about embedding quality. The stub is reached at
 * host.docker.internal because the backend runs in a container and `localhost` there is the
 * container, not this process.
 */

const EMBEDDING_DIMENSION = 1024;

/**
 * Deterministic stand-in for an embeddings API.
 *
 * Vectors are built so that meaning-related texts point the same way without sharing words: any
 * text mentioning a wishlist concept gets weight on axis 0, cart on axis 1. That is the whole
 * property under test — a paraphrase with no shared keywords still retrieves the document, which
 * is exactly what keyword search cannot do and what the vector half exists to add.
 */
function embeddingFor(text: string): number[] {
  const lower = text.toLowerCase();
  const vector = new Array(EMBEDDING_DIMENSION).fill(0);
  const wishlist = /wishlist|save .*later|bookmark|favourite|favorite/.test(lower);
  const cart = /cart|basket|checkout/.test(lower);
  vector[0] = wishlist ? 1 : 0;
  vector[1] = cart ? 1 : 0;
  // Never return a zero vector: cosine distance against one is undefined and pgvector would
  // rank it arbitrarily, which would make a failure here look like a ranking bug.
  if (!wishlist && !cart) vector[2] = 1;
  return vector;
}

interface StubState {
  server: Server;
  baseUrl: string;
  /** Every request body the backend sent, for asserting on `model` and `dimensions`. */
  requests: Array<{ model: string; input: string[]; dimensions?: number }>;
  /** Set to a status code to make the next call fail, exercising the degradation path. */
  failWith: number | null;
}

async function startEmbeddingStub(): Promise<StubState> {
  const state: Partial<StubState> = { requests: [], failWith: null };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (state.failWith) {
        res.writeHead(state.failWith, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "stubbed embeddings failure" } }));
        return;
      }
      const body = JSON.parse(raw || "{}") as { model: string; input: string[]; dimensions?: number };
      state.requests!.push(body);
      const inputs = Array.isArray(body.input) ? body.input : [String(body.input)];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: inputs.map((text, index) => ({ index, embedding: embeddingFor(text), object: "embedding" })),
          model: body.model
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const port = (server.address() as { port: number }).port;
  return Object.assign(state, { server, baseUrl: `http://host.docker.internal:${port}/v1` }) as StubState;
}

test.describe("knowledge base — embeddings allocation and semantic retrieval", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let stub: StubState;
  const createdKeyIds: string[] = [];

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("kb-embeddings");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    stub = await startEmbeddingStub();
  });

  test.afterAll(async () => {
    if (stub?.server) await new Promise<void>((resolve) => stub.server.close(() => resolve()));
    if (!tenant) return;
    for (const keyId of createdKeyIds) {
      await asOwner.delete(`/api/workspace/ai-keys/${keyId}`, { failOnStatusCode: false });
    }
    exec(`DELETE FROM knowledge_document_chunks WHERE project_id = ${literal(tenant.mainProjectId)}`);
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(Boolean(reason), reason ?? "");
    if (stub) {
      stub.requests.length = 0;
      stub.failWith = null;
    }
  });

  /** Creates a workspace AI key through the API so its secret is encrypted the way the app expects. */
  async function addKey(name: string, provider: string, baseUrl?: string): Promise<string> {
    const res = await asOwner.post("/api/workspace/ai-keys", {
      data: { name: `${name} ${Date.now()}`, provider, apiKey: `stub-${provider}-key`, ...(baseUrl ? { baseUrl } : {}) }
    });
    expect(res.ok(), `creating a ${provider} key should succeed: ${await res.text()}`).toBeTruthy();
    const id = String((await res.json()).id ?? "");
    expect(id).not.toBe("");
    createdKeyIds.push(id);
    return id;
  }

  async function allocate(keyId: string): Promise<void> {
    const res = await asOwner.post("/api/workspace/ai-keys/allocations", {
      data: { projectId: tenant!.mainProjectId, workspaceAiKeyId: keyId }
    });
    expect(res.ok(), `allocating the key should succeed: ${await res.text()}`).toBeTruthy();
  }

  async function createDocument(title: string, body: string): Promise<string> {
    const res = await asOwner.post(`/api/projects/${tenant!.mainProjectId}/knowledge-base/documents`, {
      data: { title, contentText: body, contentHtml: `<p>${body}</p>`, documentType: "general" }
    });
    expect(res.ok(), `creating the document should succeed: ${await res.text()}`).toBeTruthy();
    return String((await res.json()).id);
  }

  /** Embedding runs on a BullMQ worker, so the terminal status arrives asynchronously. */
  async function waitForStatus(documentId: string, wanted: string[], timeoutMs = 30_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let status = "";
    while (Date.now() < deadline) {
      status = scalar(`SELECT embedding_status FROM knowledge_documents WHERE id = ${literal(documentId)}`).trim();
      if (wanted.includes(status)) return status;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return status;
  }

  function chunkCount(documentId: string): number {
    return Number(
      scalar(
        `SELECT count(*) FROM knowledge_document_chunks WHERE project_id = ${literal(tenant!.mainProjectId)} AND source_id = ${literal(documentId)}`
      ).trim()
    );
  }

  test("a workspace with no embeddings-capable key leaves documents retryable, not permanently unsupported", { tag: '@tesbo.testId("TES-TC-1172")' }, async () => {
    // The self-sealing half of the outage. Anthropic cannot embed, so nothing is indexed — that
    // part is expected. What must NOT happen is the source being marked 'unsupported', which is
    // terminal and would keep it dark forever even after a capable key is added.
    const anthropic = await addKey("Claude chat", "anthropic");
    await allocate(anthropic);

    const docId = await createDocument(`E2E anthropic-only ${Date.now()}`, "Users can add plants to a wishlist and review them later.");
    const status = await waitForStatus(docId, ["pending", "unsupported", "ready", "failed"]);

    expect(status, "a missing workspace key is a property of the workspace, not of the document — it must stay retryable").toBe("pending");
    expect(chunkCount(docId)).toBe(0);
    expect(stub.requests, "no embeddings endpoint should have been called at all").toHaveLength(0);

    exec(`DELETE FROM knowledge_documents WHERE id = ${literal(docId)}`);
  });

  test("an Anthropic project borrows an embeddings-capable key from the workspace and indexes at the platform width", { tag: '@tesbo.testId("TES-TC-1173")' }, async () => {
    // The core fix. Chat stays on Claude; a second workspace key supplies the vectors. Before the
    // fix this produced zero chunks, because the allocator only ever looked at the project's own
    // allocated key and only ever accepted 'openai'.
    const openai = await addKey("Embeddings", "openai", stub.baseUrl);

    const docId = await createDocument(`E2E tier2 ${Date.now()}`, "Shoppers may add plants to a wishlist and move them to the cart when ready.");
    const status = await waitForStatus(docId, ["ready", "failed", "unsupported"]);
    expect(status, "the workspace OpenAI key should have supplied embeddings for an Anthropic-chat project").toBe("ready");

    expect(chunkCount(docId)).toBeGreaterThan(0);
    expect(stub.requests.length, "the embeddings endpoint should have been called").toBeGreaterThan(0);
    expect(stub.requests[0].model).toBe("text-embedding-3-small");
    expect(stub.requests[0].dimensions, "a natively-1536 model must be asked for the platform width, not truncated afterwards").toBe(
      EMBEDDING_DIMENSION
    );

    const widths = column(
      `SELECT DISTINCT vector_dims(embedding) FROM knowledge_document_chunks WHERE source_id = ${literal(docId)} AND project_id = ${literal(tenant!.mainProjectId)}`
    ).map((v) => Number(v.trim()));
    expect(widths, "every stored vector must match the column and its HNSW index").toEqual([EMBEDDING_DIMENSION]);

    const models = column(
      `SELECT DISTINCT embedding_model FROM knowledge_document_chunks WHERE source_id = ${literal(docId)} AND project_id = ${literal(tenant!.mainProjectId)}`
    ).map((v) => v.trim());
    expect(models, "the embedding model is recorded per chunk so a later model change can be detected").toEqual(["text-embedding-3-small"]);

    exec(`DELETE FROM knowledge_document_chunks WHERE source_id = ${literal(docId)}`);
    exec(`DELETE FROM knowledge_documents WHERE id = ${literal(docId)}`);
  });

  test("a paraphrase with no shared keywords retrieves the document — the thing keyword search cannot do", { tag: '@tesbo.testId("TES-TC-1174")' }, async () => {
    await addKey("Embeddings paraphrase", "openai", stub.baseUrl);

    const docId = await createDocument(`E2E paraphrase ${Date.now()}`, "Customers may add plants to a wishlist for future purchase.");
    expect(await waitForStatus(docId, ["ready", "failed", "unsupported"])).toBe("ready");

    const query = "how do people save items for later";
    // Keyword search first, to establish that this query genuinely has nothing to match on. If
    // this ever starts finding the document the test below stops proving anything.
    const keywordHits = Number(
      scalar(
        `SELECT count(*) FROM knowledge_documents WHERE id = ${literal(docId)} AND search_vector @@ plainto_tsquery('english', ${literal(query)})`
      ).trim()
    );
    expect(keywordHits, "the query deliberately shares no words with the document").toBe(0);

    // Now the vector half, using the same query embedding the retriever would compute.
    const queryVector = `[${embeddingFor(query).join(",")}]`;
    const nearest = scalar(
      `SELECT source_id FROM knowledge_document_chunks
       WHERE project_id = ${literal(tenant!.mainProjectId)}
       ORDER BY embedding <=> ${literal(queryVector)}::vector
       LIMIT 1`
    ).trim();
    expect(nearest, "semantic retrieval should reach the document that keyword search missed").toBe(docId);

    exec(`DELETE FROM knowledge_document_chunks WHERE source_id = ${literal(docId)}`);
    exec(`DELETE FROM knowledge_documents WHERE id = ${literal(docId)}`);
  });

  test("a document with no extractable text is genuinely unsupported and costs no API call", { tag: '@tesbo.testId("TES-TC-1175")' }, async () => {
    await addKey("Embeddings empty", "openai", stub.baseUrl);

    const docId = await createDocument(`E2E empty ${Date.now()}`, "   ");
    const status = await waitForStatus(docId, ["unsupported", "ready", "failed"]);
    expect(status, "'unsupported' is the honest terminal status for content that cannot be embedded").toBe("unsupported");
    expect(stub.requests, "an empty document must not reach the embeddings API").toHaveLength(0);

    exec(`DELETE FROM knowledge_documents WHERE id = ${literal(docId)}`);
  });

  test("an embeddings API failure marks the source failed and never throws into the caller", { tag: '@tesbo.testId("TES-TC-1176")' }, async () => {
    await addKey("Embeddings failing", "openai", stub.baseUrl);
    stub.failWith = 401;

    const docId = await createDocument(`E2E apifail ${Date.now()}`, "Wishlist behaviour for the failure path.");
    const status = await waitForStatus(docId, ["failed", "ready", "unsupported"], 45_000);
    expect(status, "a rejected key is a real failure, distinct from 'nothing to embed'").toBe("failed");
    expect(chunkCount(docId)).toBe(0);

    // Retrieval must still answer — the keyword half does not depend on embeddings at all.
    const listing = await asOwner.get(`/api/projects/${tenant!.mainProjectId}/knowledge-base/tree`);
    expect(listing.ok(), "the knowledge base must stay usable when embeddings are down").toBeTruthy();

    exec(`DELETE FROM knowledge_documents WHERE id = ${literal(docId)}`);
  });

  test("chunks never leak across projects", { tag: '@tesbo.testId("TES-TC-1177")' }, async () => {
    await addKey("Embeddings tenancy", "openai", stub.baseUrl);

    const docId = await createDocument(`E2E tenancy ${Date.now()}`, "Wishlist content scoped to the main project only.");
    expect(await waitForStatus(docId, ["ready", "failed", "unsupported"])).toBe("ready");

    const strayCount = Number(
      scalar(
        `SELECT count(*) FROM knowledge_document_chunks WHERE source_id = ${literal(docId)} AND project_id <> ${literal(tenant!.mainProjectId)}`
      ).trim()
    );
    expect(strayCount, "a chunk must exist only under the project that owns its source").toBe(0);

    const secondProjectChunks = Number(
      scalar(`SELECT count(*) FROM knowledge_document_chunks WHERE project_id = ${literal(tenant!.secondProjectId)}`).trim()
    );
    expect(secondProjectChunks, "the sibling project shares a workspace but must share no vectors").toBe(0);

    exec(`DELETE FROM knowledge_document_chunks WHERE source_id = ${literal(docId)}`);
    exec(`DELETE FROM knowledge_documents WHERE id = ${literal(docId)}`);
  });
});
