import { expect, test, type APIRequestContext } from "@playwright/test";
import { resetToLaunch, setProPlan } from "../utils/billing-db";
import { testAddress } from "../utils/env";
import { exec, literal, scalar } from "../utils/psql";
import {
  anonymousContext,
  loginAs,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  seedFixtureUser,
  type RbacTenant,
} from "../utils/rbac-tenant";
import { filesForm, pngFile, sizedFile, textFile, type UploadFile } from "../utils/uploads";

/*
 * Attachment evidence on executions and bugs: upload, list, download, delete, and the storage
 * allowance that governs all of it.
 *
 * Both uploads share one `attachments` table (entity_type 'execution' | 'bug') and one storage
 * abstraction (local disk by default, S3 when STORAGE_DRIVER=s3), and both count toward the
 * workspace's plan storage limit — so this file covers the accounting as well as the round trip.
 *
 * Runs against its own disposable workspace ("attachments"): the storage-limit cases rewrite the
 * workspace's plan and fake its usage, which no shared account can absorb.
 *
 * On the storage-limit technique: filling 500MB for real would mean pushing half a gigabyte through
 * HTTP per run. assertStorageAvailable sums attachments.file_size, so instead a synthetic row claims
 * the space and the real guard is then exercised with a small upload — the same "write the state the
 * enforcement logic reads" approach the billing suites use.
 */

const LAUNCH_LIMIT_BYTES = 500 * 1024 * 1024;

test.describe("attachments", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext;
  let asQa: APIRequestContext;
  let asGuest: APIRequestContext;
  let anon: APIRequestContext;

  /** Fixtures every test uploads against, created once. */
  let cycleId: string;
  let executionId: string;
  let bugId: string;

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("attachments");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
    asQa = await loginAs(tenant.qa);
    asGuest = await loginAs(tenant.guest);
    anon = await anonymousContext();

    const suffix = Date.now();
    const testcase = await (
      await asOwner.post(`/api/projects/${tenant.mainProjectId}/testcases`, {
        data: { title: `E2E Attachment Case ${suffix}` },
      })
    ).json();
    const cycle = await (
      await asOwner.post(`/api/projects/${tenant.mainProjectId}/cycles`, {
        data: { name: `E2E Attachment Run ${suffix}` },
      })
    ).json();
    cycleId = cycle.id;
    await asOwner.post(`/api/cycles/${cycleId}/testcases`, { data: { testcaseIds: [testcase.id] } });
    const executions = await (await asOwner.get(`/api/cycles/${cycleId}/executions`)).json();
    executionId = executions[0].id;

    const bug = await (
      await asOwner.post(`/api/projects/${tenant.mainProjectId}/bugs`, {
        data: { title: `E2E Attachment Bug ${suffix}`, severity: "Medium" },
      })
    ).json();
    bugId = bug.id;
  });

  test.afterAll(async () => {
    if (tenant) {
      // Leave the workspace on Pro: the limit tests flip it to Launch, and a tenant left on Launch
      // would refuse the second fixture project on the next run's provisioning.
      setProPlan(tenant.organizationId);
      purgeAttachments(tenant);
      if (cycleId) await asOwner.delete(`/api/cycles/${cycleId}`, { failOnStatusCode: false });
      if (bugId) await asOwner.delete(`/api/bugs/${bugId}`, { failOnStatusCode: false });
    }
    await Promise.all([asOwner, asQa, asGuest, anon].filter(Boolean).map((ctx) => ctx.dispose()));
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  test.afterEach(() => {
    // Teardown goes through Postgres, not the delete endpoint: that endpoint is itself under test
    // here, and a test that proves it's broken must not also depend on it to clean up.
    if (tenant) purgeAttachments(tenant);
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function executionUploadUrl(): string {
    return `/api/cycles/${cycleId}/executions/${executionId}/attachments`;
  }

  function bugUploadUrl(): string {
    return `/api/projects/${tenant!.mainProjectId}/bugs/${bugId}/attachments`;
  }

  async function upload(
    api: APIRequestContext,
    url: string,
    files: UploadFile[],
  ): Promise<import("@playwright/test").APIResponse> {
    return api.post(url, { multipart: filesForm(files), failOnStatusCode: false });
  }

  /** Every attachment row in this workspace, newest last. */
  function attachmentRows(t: RbacTenant): { id: string; fileSize: number; storagePath: string }[] {
    const raw = scalar(
      `SELECT COALESCE(string_agg(a.id || '|' || a.file_size || '|' || COALESCE(a.storage_path, ''), E'\\n' ORDER BY a.created_at), '') ` +
        `FROM attachments a JOIN projects p ON p.id = a.project_id ` +
        `WHERE p.organization_id = ${literal(t.organizationId)};`,
    );
    if (!raw) return [];
    return raw.split("\n").map((line) => {
      const [id, fileSize, storagePath] = line.split("|");
      return { id, fileSize: Number(fileSize), storagePath };
    });
  }

  function purgeAttachments(t: RbacTenant): void {
    exec(
      `DELETE FROM attachments WHERE project_id IN (SELECT id FROM projects WHERE organization_id = ${literal(t.organizationId)});`,
    );
  }

  /** Claims `bytes` of the workspace's allowance without moving any real data. */
  function claimStorage(t: RbacTenant, bytes: number): void {
    exec(
      `INSERT INTO attachments (project_id, entity_type, entity_id, file_name, content_type, file_size, storage_path, uploaded_by) ` +
        `VALUES (${literal(t.mainProjectId)}, 'bug', ${literal(bugId)}, 'e2e-synthetic-usage.bin', ` +
        `'application/octet-stream', ${bytes}, 'e2e/synthetic/usage.bin', ${literal(t.owner.userId)});`,
    );
  }

  async function reportedStorageBytes(): Promise<number> {
    const usage = await (await asOwner.get("/api/billing/usage")).json();
    return Number(usage.storageUsedBytes ?? usage.storage?.usedBytes ?? 0);
  }

  // ─── The round trip ────────────────────────────────────────────────────────

  test("an execution attachment uploads and appears in its list", async () => {
    const file = pngFile(`evidence-${Date.now()}.png`);
    const res = await upload(asQa, executionUploadUrl(), [file]);
    expect(res.ok(), `upload failed: ${res.status()} ${await res.text()}`).toBeTruthy();

    const listed = await (await asOwner.get(executionUploadUrl())).json();
    expect(listed.total).toBe(1);
    const [attachment] = listed.list;
    expect(attachment.fileName).toBe(file.name);
    expect(attachment.contentType).toBe("image/png");
    expect(Number(attachment.fileSize)).toBe(file.body.length);
    // The row is scoped to this execution, not just to the project.
    expect(attachment.entityType).toBe("execution");
    expect(attachment.entityId).toBe(executionId);
  });

  test("a bug attachment uploads, downloads byte-for-byte, and deletes", async () => {
    const file = textFile(`report-${Date.now()}.txt`, "the exact bytes that must come back");
    const res = await upload(asQa, bugUploadUrl(), [file]);
    expect(res.ok(), `upload failed: ${res.status()} ${await res.text()}`).toBeTruthy();

    const rows = attachmentRows(tenant!);
    expect(rows).toHaveLength(1);
    const attachmentId = rows[0].id;

    const download = await asOwner.get(
      `/api/projects/${tenant!.mainProjectId}/bugs/attachments/${attachmentId}/download`,
      { failOnStatusCode: false },
    );
    expect(download.ok(), `download failed: ${download.status()}`).toBeTruthy();
    expect(Buffer.from(await download.body()).equals(file.body)).toBeTruthy();
    expect(download.headers()["content-type"]).toContain("text/plain");
    // Evidence must arrive as a download, never rendered in the tab — see the .html case below.
    expect(download.headers()["content-disposition"]).toContain("attachment");

    const deleted = await asOwner.delete(`/api/bugs/attachments/${attachmentId}`, {
      failOnStatusCode: false,
    });
    expect(deleted.ok()).toBeTruthy();
    expect(attachmentRows(tenant!)).toHaveLength(0);

    const gone = await asOwner.get(
      `/api/projects/${tenant!.mainProjectId}/bugs/attachments/${attachmentId}/download`,
      { failOnStatusCode: false },
    );
    expect(gone.status()).toBe(404);
  });

  test("several files upload in one request", async () => {
    const suffix = Date.now();
    const files = [pngFile(`a-${suffix}.png`), textFile(`b-${suffix}.txt`), pngFile(`c-${suffix}.png`)];
    const res = await upload(asQa, executionUploadUrl(), files);
    expect(res.ok(), `upload failed: ${res.status()} ${await res.text()}`).toBeTruthy();

    const listed = await (await asOwner.get(executionUploadUrl())).json();
    expect(listed.total).toBe(3);
    expect(listed.list.map((a: any) => a.fileName).sort()).toEqual(files.map((f) => f.name).sort());
  });

  test("the ten-file cap is enforced, and ten exactly is allowed", async () => {
    const suffix = Date.now();
    const ten = Array.from({ length: 10 }, (_, i) => textFile(`ten-${suffix}-${i}.txt`));
    const atCap = await upload(asQa, executionUploadUrl(), ten);
    expect(atCap.ok(), `ten files should be accepted: ${atCap.status()} ${await atCap.text()}`).toBeTruthy();
    expect((await (await asOwner.get(executionUploadUrl())).json()).total).toBe(10);

    purgeAttachments(tenant!);

    const eleven = Array.from({ length: 11 }, (_, i) => textFile(`eleven-${suffix}-${i}.txt`));
    const overCap = await upload(asQa, executionUploadUrl(), eleven);
    expect(overCap.ok(), "eleven files should be refused").toBeFalsy();
    expect(overCap.status(), "the cap should be a clean rejection, not a 500").toBeLessThan(500);
    // Nothing partial: a refused batch must not leave the first ten behind.
    expect(attachmentRows(tenant!)).toHaveLength(0);
  });

  test("a request with no files is refused", async () => {
    for (const api of [asQa, asOwner]) {
      const res = await api.post(executionUploadUrl(), {
        multipart: filesForm([]),
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(400);
      expect((await res.json()).error).toContain("No files");
    }
    expect(attachmentRows(tenant!)).toHaveLength(0);
  });

  test("a zero-byte file is stored honestly rather than silently dropped", async () => {
    // Either outcome is defensible — refuse it, or keep it and report 0 bytes. What must not happen
    // is a 200 that reports a size the stored object doesn't have.
    const file = sizedFile(`empty-${Date.now()}.bin`, 0);
    const res = await upload(asQa, bugUploadUrl(), [file]);

    if (res.ok()) {
      const rows = attachmentRows(tenant!);
      expect(rows).toHaveLength(1);
      expect(rows[0].fileSize).toBe(0);
      const download = await asOwner.get(
        `/api/projects/${tenant!.mainProjectId}/bugs/attachments/${rows[0].id}/download`,
        { failOnStatusCode: false },
      );
      // A row that claims to exist has to be fetchable; a 500 here is the real failure.
      expect(download.status()).toBeLessThan(500);
    } else {
      expect(res.status()).toBe(400);
      expect(attachmentRows(tenant!)).toHaveLength(0);
    }
  });

  test("a megabyte file round-trips with its size recorded exactly", async () => {
    // The configured ceiling is MAX_UPLOAD_SIZE (100MB by default), which isn't practical to push
    // through HTTP in a test run — so this covers a realistically large screenshot instead, and the
    // 100MB boundary is deliberately left uncovered rather than faked.
    const file = sizedFile(`large-${Date.now()}.bin`, 1024 * 1024);
    const res = await upload(asQa, bugUploadUrl(), [file]);
    expect(res.ok(), `upload failed: ${res.status()} ${await res.text()}`).toBeTruthy();

    const rows = attachmentRows(tenant!);
    expect(rows[0].fileSize).toBe(1024 * 1024);
    const download = await asOwner.get(
      `/api/projects/${tenant!.mainProjectId}/bugs/attachments/${rows[0].id}/download`,
    );
    expect(Buffer.from(await download.body()).length).toBe(1024 * 1024);
  });

  // ─── Filenames and content types ───────────────────────────────────────────

  test("a filename that tries to escape the upload directory cannot", async () => {
    // The stored key is built from the project and execution ids plus a fresh uuid, with only the
    // EXTENSION taken from the client — so a traversal attempt must end up inside the tree. A
    // storage path containing ".." would mean an upload could overwrite anything the process can.
    const res = await upload(asQa, bugUploadUrl(), [
      { name: "../../../../etc/passwd", mimeType: "text/plain", body: Buffer.from("nope") },
    ]);
    expect(res.status(), "a traversal filename should not cause a 500").toBeLessThan(500);

    if (res.ok()) {
      const [row] = attachmentRows(tenant!);
      expect(row.storagePath).not.toContain("..");
      expect(row.storagePath.startsWith(`bugs/${tenant!.mainProjectId}/`)).toBeTruthy();
    }
  });

  test("unicode and very long filenames survive the round trip", async () => {
    const suffix = Date.now();
    const unicode = `スクリーンショット-${suffix}-café-🧪.png`;
    // 255 is the usual filesystem ceiling; the extension is kept inside the budget.
    const longName = `${"n".repeat(240)}-${suffix}.png`;

    for (const name of [unicode, longName]) {
      purgeAttachments(tenant!);
      const res = await upload(asQa, bugUploadUrl(), [pngFile(name)]);
      expect(res.status(), `"${name.slice(0, 30)}…" should not cause a 500`).toBeLessThan(500);
      if (!res.ok()) continue;

      const [row] = attachmentRows(tenant!);
      const download = await asOwner.get(
        `/api/projects/${tenant!.mainProjectId}/bugs/attachments/${row.id}/download`,
        { failOnStatusCode: false },
      );
      expect(download.ok(), `a stored file named "${name.slice(0, 30)}…" should download`).toBeTruthy();
      // The header has to be encoded, not raw — a raw newline or quote here breaks the response.
      expect(download.headers()["content-disposition"]).toContain("attachment");
    }
  });

  test("an extensionless file is accepted and still downloadable", async () => {
    const res = await upload(asQa, bugUploadUrl(), [
      { name: `noextension-${Date.now()}`, mimeType: "application/octet-stream", body: Buffer.from("x") },
    ]);
    expect(res.status()).toBeLessThan(500);
    if (!res.ok()) return;

    const [row] = attachmentRows(tenant!);
    expect(row.storagePath.endsWith("/")).toBeFalsy();
    const download = await asOwner.get(
      `/api/projects/${tenant!.mainProjectId}/bugs/attachments/${row.id}/download`,
      { failOnStatusCode: false },
    );
    expect(download.ok()).toBeTruthy();
  });

  test("an html attachment is served as a download, never rendered", async () => {
    // The XSS case: bug evidence is attacker-supplied content served from the app's own origin. If
    // the download responded with text/html and no attachment disposition, opening it would run
    // that script as the app.
    const res = await upload(asQa, bugUploadUrl(), [
      {
        name: `payload-${Date.now()}.html`,
        mimeType: "text/html",
        body: Buffer.from("<script>window.__e2e_xss = true</script>"),
      },
    ]);
    expect(res.status()).toBeLessThan(500);
    if (!res.ok()) return;

    const [row] = attachmentRows(tenant!);
    const download = await asOwner.get(
      `/api/projects/${tenant!.mainProjectId}/bugs/attachments/${row.id}/download`,
      { failOnStatusCode: false },
    );
    expect(download.ok()).toBeTruthy();
    expect(download.headers()["content-disposition"]).toContain("attachment");
  });

  test("a content type that contradicts the extension is recorded as sent, not guessed", async () => {
    const res = await upload(asQa, bugUploadUrl(), [
      { name: `mismatch-${Date.now()}.png`, mimeType: "text/plain", body: Buffer.from("not a png") },
    ]);
    expect(res.status()).toBeLessThan(500);
    if (!res.ok()) return;

    const download = await asOwner.get(
      `/api/projects/${tenant!.mainProjectId}/bugs/attachments/${attachmentRows(tenant!)[0].id}/download`,
    );
    // Whatever it stores, the download must not claim image/png for text — that combination is what
    // makes content sniffing dangerous.
    expect(download.headers()["content-type"]).toContain("text/plain");
  });

  // ─── Authorization ─────────────────────────────────────────────────────────

  test("uploading needs a session", async () => {
    for (const url of [executionUploadUrl(), bugUploadUrl()]) {
      const res = await upload(anon, url, [pngFile()]);
      expect([400, 401], `${url} should refuse an anonymous upload`).toContain(res.status());
    }
    expect(attachmentRows(tenant!)).toHaveLength(0);
  });

  test("a workspace member with no project access cannot upload evidence", async () => {
    for (const url of [executionUploadUrl(), bugUploadUrl()]) {
      const res = await upload(asGuest, url, [pngFile()]);
      expect([403, 404], `${url} should refuse a non-member of the project`).toContain(res.status());
    }
    expect(attachmentRows(tenant!)).toHaveLength(0);
  });

  test("listing execution attachments is refused without access to the run", async () => {
    // listExecutionAttachments takes only the execution id — its controller method never receives
    // the caller, and the query joins nothing — so today the list (including internal storage paths)
    // is readable by anyone who can name an execution id.
    await upload(asQa, executionUploadUrl(), [pngFile(`listing-${Date.now()}.png`)]);

    const byGuest = await asGuest.get(executionUploadUrl(), { failOnStatusCode: false });
    expect([403, 404], "a non-member should not be able to list a run's evidence").toContain(
      byGuest.status(),
    );

    const byAnon = await anon.get(executionUploadUrl(), { failOnStatusCode: false });
    expect([400, 401, 403, 404], "an anonymous caller should not be able to list evidence").toContain(
      byAnon.status(),
    );
  });

  test("an attachment cannot be downloaded by someone with no access to it", async () => {
    // downloadBugAttachment resolves the file by id alone — no session, no project join. The upload
    // path is properly scoped, so the file is only reachable by id; that id appearing in a link,
    // a log or a report shouldn't be enough to hand the file to the world.
    await upload(asQa, bugUploadUrl(), [textFile(`private-${Date.now()}.txt`, "confidential evidence")]);
    const [row] = attachmentRows(tenant!);
    const url = `/api/projects/${tenant!.mainProjectId}/bugs/attachments/${row.id}/download`;

    const byGuest = await asGuest.get(url, { failOnStatusCode: false });
    expect([403, 404], "a non-member should not be able to download the file").toContain(byGuest.status());

    const byAnon = await anon.get(url, { failOnStatusCode: false });
    expect([400, 401, 403, 404], "an anonymous caller should not be able to download the file").toContain(
      byAnon.status(),
    );
  });

  test("an attachment cannot be deleted by someone with no access to it", async () => {
    // deleteBugAttachment also takes only an id, and it deletes the stored object as well as the
    // row — so an unauthorized caller doesn't just read someone's evidence, they destroy it.
    await upload(asQa, bugUploadUrl(), [textFile(`deletable-${Date.now()}.txt`)]);
    const [row] = attachmentRows(tenant!);

    const byAnon = await anon.delete(`/api/bugs/attachments/${row.id}`, { failOnStatusCode: false });
    expect([400, 401, 403, 404], "an anonymous caller should not be able to delete evidence").toContain(
      byAnon.status(),
    );
    expect(attachmentRows(tenant!), "the file should still be there").toHaveLength(1);

    const byGuest = await asGuest.delete(`/api/bugs/attachments/${row.id}`, { failOnStatusCode: false });
    expect([403, 404], "a non-member should not be able to delete evidence").toContain(byGuest.status());
    expect(attachmentRows(tenant!)).toHaveLength(1);
  });

  // ─── Missing and malformed targets ─────────────────────────────────────────

  test("uploading to something that doesn't exist is a clean 404", async () => {
    const missing = "00000000-0000-0000-0000-000000000000";
    const cases = [
      `/api/cycles/${cycleId}/executions/${missing}/attachments`,
      `/api/cycles/${missing}/executions/${executionId}/attachments`,
      `/api/projects/${tenant!.mainProjectId}/bugs/${missing}/attachments`,
    ];
    for (const url of cases) {
      const res = await upload(asOwner, url, [pngFile()]);
      expect(res.status(), `${url} should be a clean 404`).toBe(404);
    }
  });

  test("a malformed id fails cleanly, never with a 500", async () => {
    const cases = [
      `/api/cycles/${cycleId}/executions/not-a-uuid/attachments`,
      `/api/projects/${tenant!.mainProjectId}/bugs/not-a-uuid/attachments`,
    ];
    for (const url of cases) {
      const res = await upload(asOwner, url, [pngFile()]);
      expect(res.status(), `${url} should fail cleanly`).toBeLessThan(500);
      expect(res.ok()).toBeFalsy();
    }

    for (const url of [
      `/api/projects/${tenant!.mainProjectId}/bugs/attachments/not-a-uuid/download`,
      `/api/bugs/attachments/not-a-uuid`,
    ]) {
      const res = url.endsWith("download")
        ? await asOwner.get(url, { failOnStatusCode: false })
        : await asOwner.delete(url, { failOnStatusCode: false });
      expect(res.status(), `${url} should fail cleanly`).toBeLessThan(500);
    }
  });

  // ─── Storage accounting and the plan ceiling ───────────────────────────────

  test("uploaded bytes are reported as storage used, and freed again on delete", async () => {
    const before = await reportedStorageBytes();
    const file = sizedFile(`accounted-${Date.now()}.bin`, 64 * 1024);

    expect((await upload(asQa, bugUploadUrl(), [file])).ok()).toBeTruthy();
    expect(await reportedStorageBytes()).toBe(before + file.body.length);

    const [row] = attachmentRows(tenant!);
    expect((await asOwner.delete(`/api/bugs/attachments/${row.id}`)).ok()).toBeTruthy();
    expect(
      await reportedStorageBytes(),
      "deleting evidence has to give the space back, or a workspace fills up permanently",
    ).toBe(before);
  });

  test("an upload that would exceed the Launch ceiling is refused with a route out", async () => {
    try {
      resetToLaunch(tenant!.organizationId);
      // One byte short of the ceiling, so any real upload has to be refused.
      claimStorage(tenant!, LAUNCH_LIMIT_BYTES - 1);

      const res = await upload(asQa, bugUploadUrl(), [sizedFile(`over-${Date.now()}.bin`, 4096)]);
      expect(res.status()).toBe(403);
      const { error } = await res.json();
      expect(error).toContain("storage limit");
      expect(error, "a Launch workspace has somewhere to go — say so").toContain("Upgrade to Pro");
    } finally {
      setProPlan(tenant!.organizationId);
      purgeAttachments(tenant!);
    }
  });

  test("a Pro workspace at its ceiling is pointed at support, not at an upgrade", async () => {
    try {
      setProPlan(tenant!.organizationId);
      claimStorage(tenant!, 5 * 1024 * 1024 * 1024 - 1);

      const res = await upload(asQa, bugUploadUrl(), [sizedFile(`over-pro-${Date.now()}.bin`, 4096)]);
      expect(res.status()).toBe(403);
      const { error } = await res.json();
      expect(error).toContain("storage limit");
      expect(error, "Pro is the largest plan, so 'upgrade' is a dead end").not.toContain("Upgrade to Pro");
      expect(error).toContain("contact");
    } finally {
      purgeAttachments(tenant!);
    }
  });

  test("freeing space makes a refused upload possible again", async () => {
    try {
      resetToLaunch(tenant!.organizationId);
      claimStorage(tenant!, LAUNCH_LIMIT_BYTES - 1);

      const file = sizedFile(`retry-${Date.now()}.bin`, 4096);
      expect((await upload(asQa, bugUploadUrl(), [file])).status()).toBe(403);

      // Release the claimed space the way a user would: delete the thing taking it up.
      const claimed = attachmentRows(tenant!).find((r) => r.fileSize === LAUNCH_LIMIT_BYTES - 1)!;
      exec(`DELETE FROM attachments WHERE id = ${literal(claimed.id)};`);

      const retry = await upload(asQa, bugUploadUrl(), [file]);
      expect(retry.ok(), `the upload should succeed once space is free: ${await retry.text()}`).toBeTruthy();
    } finally {
      setProPlan(tenant!.organizationId);
      purgeAttachments(tenant!);
    }
  });

  // ─── What happens to evidence when its parent goes ─────────────────────────

  test("deleting a bug does not leave its evidence billing the workspace", async () => {
    // Whichever way the product goes — cascade the rows or keep them — the workspace must not be
    // charged for storage it can no longer see or delete through the UI.
    const suffix = Date.now();
    const throwaway = await (
      await asOwner.post(`/api/projects/${tenant!.mainProjectId}/bugs`, {
        data: { title: `E2E Attachment Orphan Bug ${suffix}`, severity: "Low" },
      })
    ).json();

    const file = sizedFile(`orphan-${suffix}.bin`, 32 * 1024);
    const uploaded = await upload(asQa, `/api/projects/${tenant!.mainProjectId}/bugs/${throwaway.id}/attachments`, [
      file,
    ]);
    expect(uploaded.ok()).toBeTruthy();
    const before = await reportedStorageBytes();
    expect(before).toBeGreaterThanOrEqual(file.body.length);

    expect((await asOwner.delete(`/api/bugs/${throwaway.id}`)).ok()).toBeTruthy();

    const stillBilled = (await reportedStorageBytes()) >= file.body.length;
    const stillReachable = attachmentRows(tenant!).length > 0;
    if (stillBilled) {
      // If the bytes are still counted, the attachment must still be reachable and deletable —
      // otherwise the space can never be reclaimed by any means the product offers.
      expect(
        stillReachable,
        "storage is still counted for a deleted bug's evidence with no way left to remove it",
      ).toBeTruthy();
      const [row] = attachmentRows(tenant!);
      const download = await asOwner.get(
        `/api/projects/${tenant!.mainProjectId}/bugs/attachments/${row.id}/download`,
        { failOnStatusCode: false },
      );
      expect(download.status(), "orphaned evidence should not 500").toBeLessThan(500);
    }
  });

  test("an outsider with no workspace at all is refused everywhere", async () => {
    const email = testAddress("attach-outsider");
    const outsider = seedFixtureUser(email, "E2E Attachment Outsider");
    const asOutsider = await loginAs(outsider);
    try {
      await upload(asQa, bugUploadUrl(), [textFile(`outsider-${Date.now()}.txt`)]);
      const [row] = attachmentRows(tenant!);

      const uploadRes = await upload(asOutsider, bugUploadUrl(), [pngFile()]);
      expect(uploadRes.ok()).toBeFalsy();

      const downloadRes = await asOutsider.get(
        `/api/projects/${tenant!.mainProjectId}/bugs/attachments/${row.id}/download`,
        { failOnStatusCode: false },
      );
      expect([400, 401, 403, 404]).toContain(downloadRes.status());
    } finally {
      await asOutsider.dispose();
    }
  });
});
