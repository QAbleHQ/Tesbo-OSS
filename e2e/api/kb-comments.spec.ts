import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { exec, literal, scalar } from "../utils/psql";
import {
  anonymousContext,
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  type RbacTenant,
} from "../utils/rbac-tenant";

/*
 * Knowledge Base v2 — document comments.
 *
 * Wave 5, on its own workspace ("kb-comments"). A Google-Docs-shaped discussion: threads one level
 * deep, resolvable from the thread root, optionally anchored to a quoted passage.
 *
 * The reason comments exist as their own table rather than as part of the document body is the case
 * KBC-A-18 covers: a document mirrored from Jira or Linear is rewritten wholesale by every sync, so
 * its body cannot be edited — comments are the only writable channel on it, and they have to survive
 * the sync that overwrites everything else.
 *
 * The permission split is deliberate and asymmetric, and three tests exist to pin it:
 *   - editing the WORDING is the author's alone, whatever their role (a manager rewriting someone
 *     else's comment would misattribute it)
 *   - RESOLVING is triage, so it follows the usual KB rule: owner, manager, or the author
 *   - DELETING follows the same KB rule, and takes the thread's replies with it
 */

test.describe("knowledge base v2 — document comments", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let asManager: APIRequestContext;
  let asQa: APIRequestContext;
  let asGuest: APIRequestContext;
  let anon: APIRequestContext;
  let rootFolderId = "";
  /** One document all the comment tests hang off; recreated per test so counts start at zero. */
  let documentId = "";

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("kb-comments");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    asManager = await loginAs(tenant.manager);
    asQa = await loginAs(tenant.qa);
    asGuest = await loginAs(tenant.guest);
    anon = await anonymousContext();

    purgeKb(tenant);
    ensureRootFolder(tenant);
    rootFolderId = (await (await asOwner.get(kbUrl("/folders/tree"))).json()).id;
  });

  test.afterAll(async () => {
    if (tenant) purgeKb(tenant);
    await Promise.all([asOwner, asManager, asQa, asGuest, anon].filter(Boolean).map((c) => c.dispose()));
  });

  test.beforeEach(async () => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
    documentId = (await createDocument(`E2E Commented ${Date.now()}${Math.floor(Math.random() * 1000)}`)).id;
  });

  test.afterEach(() => {
    if (tenant) purgeKb(tenant);
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function kbUrl(suffix: string, projectId?: string): string {
    return `/api/projects/${projectId ?? tenant!.mainProjectId}/knowledge-base${suffix}`;
  }

  function purgeKb(t: RbacTenant): void {
    const projects = `${literal(t.mainProjectId)}, ${literal(t.secondProjectId)}`;
    exec(`DELETE FROM knowledge_document_comments WHERE project_id IN (${projects});`);
    exec(`DELETE FROM knowledge_documents WHERE project_id IN (${projects});`);
    exec(`DELETE FROM knowledge_folders WHERE project_id IN (${projects}) AND is_root = false;`);
  }

  /** See the same helper in api/knowledge-base.spec.ts — this backfills pre-fix onboarding rows. */
  function ensureRootFolder(t: RbacTenant): void {
    for (const projectId of [t.mainProjectId, t.secondProjectId]) {
      if (scalar(`SELECT COUNT(*) FROM knowledge_folders WHERE project_id = ${literal(projectId)} AND is_root = true;`) !== "0")
        continue;
      exec(
        "INSERT INTO knowledge_folders (organization_id, project_id, parent_folder_id, name, is_root) " +
          `VALUES (${literal(t.organizationId)}, ${literal(projectId)}, NULL, 'Knowledge base', true);`,
      );
    }
  }

  async function createDocument(title: string, projectId?: string): Promise<any> {
    const folderId = projectId
      ? (await (await asOwner.get(kbUrl("/folders/tree", projectId))).json()).id
      : rootFolderId;
    const res = await asOwner.post(kbUrl("/documents", projectId), {
      data: { title, folderId, contentText: "a document worth discussing" },
      failOnStatusCode: false,
    });
    expect(res.status(), `creating document ${title} — ${await res.text()}`).toBe(201);
    return res.json();
  }

  function commentsUrl(docId: string = documentId, projectId?: string): string {
    return kbUrl(`/documents/${docId}/comments`, projectId);
  }

  function commentUrl(commentId: string, projectId?: string): string {
    return kbUrl(`/comments/${commentId}`, projectId);
  }

  async function comment(
    body: Record<string, unknown>,
    api: APIRequestContext = asOwner,
    docId: string = documentId,
    projectId?: string,
  ): Promise<any> {
    const res = await api.post(commentsUrl(docId, projectId), { data: body, failOnStatusCode: false });
    expect(res.status(), `commenting ${JSON.stringify(body)} — ${await res.text()}`).toBe(201);
    return res.json();
  }

  async function listComments(api: APIRequestContext = asOwner, docId: string = documentId): Promise<any> {
    const res = await api.get(commentsUrl(docId), { failOnStatusCode: false });
    expect(res.status(), `listing comments — ${await res.text()}`).toBe(200);
    return res.json();
  }

  // ─── The primary flow ──────────────────────────────────────────────────────

  test("KBC-A-01 a comment is posted, listed with its author's name, and counted as open", async () => {
    const posted = await comment({ body: "Is this section still accurate?" });
    expect(posted.body).toBe("Is this section still accurate?");
    expect(posted.authorId).toBe(tenant!.owner.userId);
    expect(posted.authorName).toBeTruthy();
    expect(posted.isResolved).toBe(false);
    expect(posted.parentCommentId).toBeNull();
    expect(posted.replies).toEqual([]);

    const list = await listComments();
    expect(list.total).toBe(1);
    expect(list.openCount).toBe(1);
    expect(list.list[0].id).toBe(posted.id);
    // The author's display name is resolved server-side, so a client needs no second lookup to
    // render the thread.
    expect(list.list[0].authorName).toBe(posted.authorName);
  });

  test("KBC-A-02 a reply nests under its thread root rather than appearing as a second thread", async () => {
    const root = await comment({ body: "Question" });
    const reply = await comment({ body: "Answer", parentCommentId: root.id }, asManager);
    expect(reply.parentCommentId).toBe(root.id);

    const list = await listComments();
    // One thread, not two — the reply is inside it.
    expect(list.total).toBe(1);
    expect(list.list[0].id).toBe(root.id);
    expect(list.list[0].replies.map((r: any) => r.id)).toEqual([reply.id]);

    const second = await comment({ body: "Another thought", parentCommentId: root.id }, asQa);
    const reread = await listComments();
    // Replies keep their posting order, which is what makes a conversation readable.
    expect(reread.list[0].replies.map((r: any) => r.id)).toEqual([reply.id, second.id]);
  });

  test("KBC-A-03 a reply to a reply is refused so threads stay one level deep", async () => {
    const root = await comment({ body: "Root" });
    const reply = await comment({ body: "Reply", parentCommentId: root.id });

    const res = await asOwner.post(commentsUrl(), {
      data: { body: "Reply to the reply", parentCommentId: reply.id },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("top comment of the thread");

    // Nothing was written on the way to the refusal.
    const list = await listComments();
    expect(list.list[0].replies).toHaveLength(1);
  });

  test("KBC-A-04 a thread root carries an anchor to the passage it is about", async () => {
    const anchored = await comment({
      body: "This paragraph contradicts the one above",
      anchorText: "a document worth discussing",
      anchorStart: 0,
      anchorEnd: 27,
    });
    expect(anchored.anchorText).toBe("a document worth discussing");
    expect(anchored.anchorStart).toBe(0);
    expect(anchored.anchorEnd).toBe(27);

    // A reply is part of the thread, not a separate annotation, so it carries no anchor of its own
    // even when one is offered.
    const reply = await comment({
      body: "Agreed",
      parentCommentId: anchored.id,
      anchorText: "somewhere else",
      anchorStart: 5,
      anchorEnd: 9,
    });
    expect(reply.anchorText).toBeNull();
    expect(reply.anchorStart).toBeNull();
    expect(reply.anchorEnd).toBeNull();
  });

  test("KBC-A-05 an anchor with no offsets is kept, and offsets with no anchor are dropped", async () => {
    const textOnly = await comment({ body: "Anchored loosely", anchorText: "worth discussing" });
    expect(textOnly.anchorText).toBe("worth discussing");
    expect(textOnly.anchorStart).toBeNull();
    expect(textOnly.anchorEnd).toBeNull();

    // Offsets without the quoted text are meaningless — the document can be edited underneath them,
    // and the text is what lets a client re-find the passage after that.
    const offsetsOnly = await comment({ body: "Offsets only", anchorStart: 3, anchorEnd: 9 });
    expect(offsetsOnly.anchorText).toBeNull();
    expect(offsetsOnly.anchorStart).toBeNull();
    expect(offsetsOnly.anchorEnd).toBeNull();

    // A negative offset is clamped rather than stored.
    const negative = await comment({ body: "Negative", anchorText: "x", anchorStart: -5, anchorEnd: -1 });
    expect(negative.anchorStart).toBe(0);
    expect(negative.anchorEnd).toBe(0);
  });

  // ─── Editing ──────────────────────────────────────────────────────────────

  test("KBC-A-06 an author edits their own comment", async () => {
    const posted = await comment({ body: "Frist draft" }, asQa);
    const res = await asQa.patch(commentUrl(posted.id), {
      data: { body: "First draft" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).body).toBe("First draft");
    expect(scalar(`SELECT body FROM knowledge_document_comments WHERE id = ${literal(posted.id)};`)).toBe("First draft");
  });

  test("KBC-A-07 nobody else edits the wording, not even an owner or a manager", async () => {
    const posted = await comment({ body: "Written by the QA engineer" }, asQa);

    for (const [who, api] of [
      ["owner", asOwner],
      ["manager", asManager],
    ] as const) {
      const res = await api.patch(commentUrl(posted.id), {
        data: { body: `rewritten by the ${who}` },
        failOnStatusCode: false,
      });
      // Rewriting someone else's words under their name is misattribution, so this is refused for
      // every role — unlike resolving and deleting, which a manager may do.
      expect(res.status(), `an ${who} rewrote someone else's comment`).toBe(403);
      expect(JSON.stringify(await res.json())).toContain("only edit your own comments");
    }
    expect(scalar(`SELECT body FROM knowledge_document_comments WHERE id = ${literal(posted.id)};`)).toBe(
      "Written by the QA engineer",
    );
  });

  test("KBC-A-08 an empty, whitespace-only, or over-long comment is refused on create and on edit", async () => {
    for (const body of [{}, { body: "" }, { body: "   " }, { body: "\n\t " }]) {
      const res = await asOwner.post(commentsUrl(), { data: body, failOnStatusCode: false });
      expect(res.status(), `${JSON.stringify(body)} was accepted`).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("cannot be empty");
    }

    // 10,000 characters is the documented ceiling: one under is fine, one over is refused.
    const atLimit = await comment({ body: "x".repeat(10_000) });
    expect(atLimit.body).toHaveLength(10_000);

    const overLimit = await asOwner.post(commentsUrl(), {
      data: { body: "x".repeat(10_001) },
      failOnStatusCode: false,
    });
    expect(overLimit.status()).toBe(400);
    expect(JSON.stringify(await overLimit.json())).toContain("too long");

    // The same two rules apply to an edit, or the limit is only a create-time formality.
    const posted = await comment({ body: "fine" });
    const emptied = await asOwner.patch(commentUrl(posted.id), { data: { body: "  " }, failOnStatusCode: false });
    expect(emptied.status()).toBe(400);
    const grown = await asOwner.patch(commentUrl(posted.id), {
      data: { body: "y".repeat(10_001) },
      failOnStatusCode: false,
    });
    expect(grown.status()).toBe(400);
    expect(scalar(`SELECT body FROM knowledge_document_comments WHERE id = ${literal(posted.id)};`)).toBe("fine");
  });

  test("KBC-A-09 a comment's body is trimmed rather than stored with its surrounding whitespace", async () => {
    const posted = await comment({ body: "   padded on both sides   " });
    expect(posted.body).toBe("padded on both sides");
  });

  // ─── Resolving ────────────────────────────────────────────────────────────

  test("KBC-A-10 resolving a thread records who resolved it and drops the open count", async () => {
    const first = await comment({ body: "Thread one" });
    await comment({ body: "Thread two" });
    expect((await listComments()).openCount).toBe(2);

    const res = await asOwner.patch(commentUrl(first.id), { data: { isResolved: true }, failOnStatusCode: false });
    expect(res.status()).toBe(200);
    const resolved = await res.json();
    expect(resolved.isResolved).toBe(true);
    expect(resolved.resolvedBy).toBe(tenant!.owner.userId);
    expect(resolved.resolvedByName).toBeTruthy();
    expect(resolved.resolvedAt).toBeTruthy();

    const list = await listComments();
    // Resolved threads stay in the list — they are history, not deletions — but stop counting as open.
    expect(list.total).toBe(2);
    expect(list.openCount).toBe(1);
  });

  test("KBC-A-11 a resolved thread is reopened, and the resolver is cleared with it", async () => {
    const posted = await comment({ body: "Reopenable" });
    await asOwner.patch(commentUrl(posted.id), { data: { isResolved: true }, failOnStatusCode: false });

    const res = await asOwner.patch(commentUrl(posted.id), { data: { isResolved: false }, failOnStatusCode: false });
    expect(res.status()).toBe(200);
    const reopened = await res.json();
    expect(reopened.isResolved).toBe(false);
    // Stale resolver metadata on an open thread would render as "resolved by X" next to an open
    // marker, so it is cleared rather than left behind.
    expect(reopened.resolvedBy).toBeNull();
    expect(reopened.resolvedAt).toBeNull();
    expect((await listComments()).openCount).toBe(1);
  });

  test("KBC-A-12 a reply cannot be resolved on its own — the thread is resolved from its root", async () => {
    const root = await comment({ body: "Root" });
    const reply = await comment({ body: "Reply", parentCommentId: root.id });

    const res = await asOwner.patch(commentUrl(reply.id), { data: { isResolved: true }, failOnStatusCode: false });
    expect(res.status()).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("whole thread from its top comment");
    expect((await listComments()).openCount).toBe(1);
  });

  test("KBC-A-13 a manager resolves anyone's thread, and a qa_engineer only their own", async () => {
    const theirs = await comment({ body: "Owner's thread" });
    const mine = await comment({ body: "QA's thread" }, asQa);

    // The author may resolve their own regardless of role.
    expect(
      (await asQa.patch(commentUrl(mine.id), { data: { isResolved: true }, failOnStatusCode: false })).status(),
    ).toBe(200);

    // Someone else's is refused for a qa_engineer — resolving follows kbRequireMutateAccess.
    const refused = await asQa.patch(commentUrl(theirs.id), { data: { isResolved: true }, failOnStatusCode: false });
    expect(refused.status()).toBe(403);
    expect(scalar(`SELECT is_resolved FROM knowledge_document_comments WHERE id = ${literal(theirs.id)};`)).toBe("f");

    // A manager is not bound by authorship.
    expect(
      (await asManager.patch(commentUrl(theirs.id), { data: { isResolved: true }, failOnStatusCode: false })).status(),
    ).toBe(200);
  });

  // ─── Deleting ─────────────────────────────────────────────────────────────

  test("KBC-A-14 deleting a thread root takes its replies with it", async () => {
    const root = await comment({ body: "Doomed thread" });
    const reply = await comment({ body: "Doomed reply", parentCommentId: root.id }, asManager);
    const survivor = await comment({ body: "Unrelated thread" });

    const res = await asOwner.delete(commentUrl(root.id), { failOnStatusCode: false });
    expect(res.status()).toBe(200);
    expect((await res.json()).success).toBe(true);

    // Soft-deleted, root and reply together — an orphaned reply would either vanish from the view
    // or silently reattach itself to another thread.
    expect(scalar(`SELECT is_deleted FROM knowledge_document_comments WHERE id = ${literal(root.id)};`)).toBe("t");
    expect(scalar(`SELECT is_deleted FROM knowledge_document_comments WHERE id = ${literal(reply.id)};`)).toBe("t");

    const list = await listComments();
    expect(list.list.map((c: any) => c.id)).toEqual([survivor.id]);
    expect(list.total).toBe(1);
  });

  test("KBC-A-15 deleting a single reply leaves its thread standing", async () => {
    const root = await comment({ body: "Surviving thread" });
    const doomed = await comment({ body: "Doomed reply", parentCommentId: root.id });
    const kept = await comment({ body: "Kept reply", parentCommentId: root.id });

    expect((await asOwner.delete(commentUrl(doomed.id), { failOnStatusCode: false })).status()).toBe(200);

    const list = await listComments();
    expect(list.total).toBe(1);
    expect(list.list[0].replies.map((r: any) => r.id)).toEqual([kept.id]);
  });

  test("KBC-A-16 a qa_engineer deletes their own comment but not someone else's", async () => {
    const mine = await comment({ body: "QA's own" }, asQa);
    const theirs = await comment({ body: "Owner's" });

    expect((await asQa.delete(commentUrl(mine.id), { failOnStatusCode: false })).status()).toBe(200);

    const refused = await asQa.delete(commentUrl(theirs.id), { failOnStatusCode: false });
    expect(refused.status()).toBe(403);
    expect(scalar(`SELECT is_deleted FROM knowledge_document_comments WHERE id = ${literal(theirs.id)};`)).toBe("f");

    // A manager may delete anyone's.
    expect((await asManager.delete(commentUrl(theirs.id), { failOnStatusCode: false })).status()).toBe(200);
  });

  test("KBC-A-17 a deleted comment cannot be edited, resolved or deleted again", async () => {
    const posted = await comment({ body: "Gone" });
    await asOwner.delete(commentUrl(posted.id), { failOnStatusCode: false });

    for (const attempt of [
      asOwner.patch(commentUrl(posted.id), { data: { body: "back?" }, failOnStatusCode: false }),
      asOwner.patch(commentUrl(posted.id), { data: { isResolved: true }, failOnStatusCode: false }),
      asOwner.delete(commentUrl(posted.id), { failOnStatusCode: false }),
    ]) {
      const res = await attempt;
      expect(res.status(), `a deleted comment answered ${res.status()}`).toBe(404);
    }
  });

  // ─── Read-only provider mirrors ───────────────────────────────────────────

  test("KBC-A-18 a document synced from a provider still takes comments, which is the point of them", async () => {
    const doc = await createDocument(`E2E Jira mirror ${Date.now()}`);
    exec(
      `UPDATE knowledge_documents SET is_read_only = true, source_provider = 'jira' WHERE id = ${literal(doc.id)};`,
    );

    // The body is provider-owned and refuses edits...
    const bodyEdit = await asOwner.patch(kbUrl(`/documents/${doc.id}`), {
      data: { contentText: "edited by hand" },
      failOnStatusCode: false,
    });
    expect(bodyEdit.status()).toBe(400);

    // ...but the comment thread is ours, and must still work. This is the whole reason comments
    // live in their own table: a sync rewrites the document and leaves the discussion intact.
    const posted = await comment({ body: "This ticket's description is out of date" }, asOwner, doc.id);
    expect(posted.id).toBeTruthy();
    const list = await listComments(asOwner, doc.id);
    expect(list.total).toBe(1);

    // Simulating the next sync overwriting the body: the comment survives it.
    exec(
      `UPDATE knowledge_documents SET content_text = 'rewritten by sync', updated_at = now() ` +
        `WHERE id = ${literal(doc.id)};`,
    );
    const afterSync = await listComments(asOwner, doc.id);
    expect(afterSync.list.map((c: any) => c.id)).toEqual([posted.id]);
  });

  // ─── Validation and scoping ───────────────────────────────────────────────

  test("KBC-A-19 comments on an unknown, deleted, or malformed document id are refused", async () => {
    const unknown = await asOwner.get(kbUrl("/documents/11111111-1111-4111-8111-111111111111/comments"), {
      failOnStatusCode: false,
    });
    expect(unknown.status()).toBe(404);

    for (const bad of ["not-a-uuid", "0"]) {
      const res = await asOwner.get(kbUrl(`/documents/${bad}/comments`), { failOnStatusCode: false });
      expect(res.status(), `document id "${bad}" answered ${res.status()}: ${await res.text()}`).toBeLessThan(500);
      const posted = await asOwner.post(kbUrl(`/documents/${bad}/comments`), {
        data: { body: "x" },
        failOnStatusCode: false,
      });
      expect(posted.status()).toBeLessThan(500);
    }

    // A document deleted after a thread was opened takes the thread's route with it.
    const posted = await comment({ body: "About to be orphaned" });
    await asOwner.delete(kbUrl(`/documents/${documentId}`), { failOnStatusCode: false });
    const afterDelete = await asOwner.get(commentsUrl(), { failOnStatusCode: false });
    expect(afterDelete.status()).toBe(404);
    // The row itself is untouched, so restoring the document brings the discussion back.
    expect(scalar(`SELECT is_deleted FROM knowledge_document_comments WHERE id = ${literal(posted.id)};`)).toBe("f");
    await asOwner.patch(kbUrl(`/documents/${documentId}/restore`), { failOnStatusCode: false });
    expect((await listComments()).list.map((c: any) => c.id)).toEqual([posted.id]);
  });

  test("KBC-A-20 a malformed or unknown comment id is a 404, not a 500", async () => {
    for (const bad of ["not-a-uuid", "0", "11111111-1111-4111-8111-111111111111"]) {
      for (const attempt of [
        asOwner.patch(commentUrl(bad), { data: { body: "x" }, failOnStatusCode: false }),
        asOwner.patch(commentUrl(bad), { data: { isResolved: true }, failOnStatusCode: false }),
        asOwner.delete(commentUrl(bad), { failOnStatusCode: false }),
      ]) {
        const res = await attempt;
        expect(res.status(), `comment id "${bad}" answered ${res.status()}: ${await res.text()}`).toBe(404);
      }
    }

    // Same for a reply target that doesn't exist.
    for (const parentCommentId of ["not-a-uuid", "11111111-1111-4111-8111-111111111111"]) {
      const res = await asOwner.post(commentsUrl(), {
        data: { body: "reply into the void", parentCommentId },
        failOnStatusCode: false,
      });
      expect(res.status(), `parentCommentId "${parentCommentId}" answered ${res.status()}`).toBe(404);
    }
  });

  test("KBC-A-21 a reply cannot be attached to a comment on a different document", async () => {
    const otherDoc = await createDocument(`E2E Other doc ${Date.now()}`);
    const foreignRoot = await comment({ body: "On the other document" }, asOwner, otherDoc.id);

    const res = await asOwner.post(commentsUrl(), {
      data: { body: "Crossing documents", parentCommentId: foreignRoot.id },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(404);
    expect((await listComments()).total).toBe(0);
  });

  test("KBC-A-22 a comment in another project is not reachable through this project's URL", async () => {
    const foreignDoc = await createDocument(`E2E Foreign doc ${Date.now()}`, tenant!.secondProjectId);
    // Posted through the SECOND project's own URL — the point of the test is reaching it through
    // the first project's URL below, not creating it there.
    const foreign = await comment(
      { body: "Belongs to the other project" },
      asOwner,
      foreignDoc.id,
      tenant!.secondProjectId,
    );

    // Posted under the second project, reached for through the first one's URL.
    for (const attempt of [
      asOwner.patch(commentUrl(foreign.id), { data: { body: "rewritten" }, failOnStatusCode: false }),
      asOwner.patch(commentUrl(foreign.id), { data: { isResolved: true }, failOnStatusCode: false }),
      asOwner.delete(commentUrl(foreign.id), { failOnStatusCode: false }),
    ]) {
      const res = await attempt;
      expect(res.status(), `a cross-project comment id answered ${res.status()}: ${await res.text()}`).toBe(404);
    }
    expect(scalar(`SELECT is_deleted FROM knowledge_document_comments WHERE id = ${literal(foreign.id)};`)).toBe("f");
    expect(scalar(`SELECT body FROM knowledge_document_comments WHERE id = ${literal(foreign.id)};`)).toBe(
      "Belongs to the other project",
    );
  });

  // ─── Authorization ────────────────────────────────────────────────────────

  test("KBC-A-23 no comment route answers a caller with no session", async () => {
    const posted = await comment({ body: "Guarded" });

    const attempts: Array<[string, () => Promise<APIResponse>]> = [
      ["GET comments", () => anon.get(commentsUrl(), { failOnStatusCode: false })],
      ["POST comment", () => anon.post(commentsUrl(), { data: { body: "anon" }, failOnStatusCode: false })],
      [
        "PATCH comment",
        () => anon.patch(commentUrl(posted.id), { data: { body: "anon rewrote this" }, failOnStatusCode: false }),
      ],
      [
        "PATCH resolve",
        () => anon.patch(commentUrl(posted.id), { data: { isResolved: true }, failOnStatusCode: false }),
      ],
      ["DELETE comment", () => anon.delete(commentUrl(posted.id), { failOnStatusCode: false })],
    ];

    for (const [what, attempt] of attempts) {
      const res = await attempt();
      expect(
        [400, 401, 403, 404],
        `${what} answered an anonymous caller with ${res.status()}: ${await res.text()}`,
      ).toContain(res.status());
    }

    const list = await listComments();
    expect(list.total).toBe(1);
    expect(list.list[0].body).toBe("Guarded");
    expect(list.list[0].isResolved).toBe(false);
  });

  test("KBC-A-24 a workspace member with no project access cannot read or write the discussion", async () => {
    const posted = await comment({ body: "Members only" });

    for (const attempt of [
      asGuest.get(commentsUrl(), { failOnStatusCode: false }),
      asGuest.post(commentsUrl(), { data: { body: "guest" }, failOnStatusCode: false }),
      asGuest.patch(commentUrl(posted.id), { data: { body: "guest" }, failOnStatusCode: false }),
      asGuest.patch(commentUrl(posted.id), { data: { isResolved: true }, failOnStatusCode: false }),
      asGuest.delete(commentUrl(posted.id), { failOnStatusCode: false }),
    ]) {
      const res = await attempt;
      expect([403, 404], `a non-member got ${res.status()}: ${await res.text()}`).toContain(res.status());
    }
    expect((await listComments()).total).toBe(1);
  });

  test("KBC-A-25 every project member can read the discussion and add to it", async () => {
    const root = await comment({ body: "Started by the owner" });
    for (const [who, api] of [
      ["manager", asManager],
      ["qa_engineer", asQa],
    ] as const) {
      const reply = await comment({ body: `Replied to by the ${who}`, parentCommentId: root.id }, api);
      expect(reply.parentCommentId).toBe(root.id);
      const list = await listComments(api);
      expect(list.total, `a ${who} could not read the thread`).toBe(1);
    }
    expect((await listComments()).list[0].replies).toHaveLength(2);
  });
});
