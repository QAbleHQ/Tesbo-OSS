import { expect, test, type APIRequestContext } from "@playwright/test";
import { accountA, anonymousApiContext, apiContext, apiContextB, createBug, ticket, unique } from "../fixtures";
import { filesForm, pngFile, sizedFile, type UploadFile } from "../../utils/uploads";

/*
 * Reported-ticket regression for bug evidence validation.
 * Card 10226296533 — "[Bug Attachments] Missing File Type and Size Validations Cause Upload to Get
 * Stuck on Saving".
 *
 * Nothing validated type or size before the fix: every extension was accepted, and the only ceiling
 * was the upload interceptor's 100MB, which multer enforces mid-stream — so the caller got a failure
 * with no field-level reason and the reporting modal simply sat on "Saving…". Both evidence routes
 * validate the whole batch up front now (LegacyService.assertValidEvidenceFiles).
 *
 * WHY IT IS COVERED AGAIN HERE. api/attachments.spec.ts owns this endpoint and covers it more
 * deeply, but it provisions an RBAC tenant, flips plans through utils/billing-db and verifies
 * "nothing was stored" by SELECTing the attachments table through utils/psql. On a deployed
 * environment none of that is reachable, so the whole file skips and this card had no cover there.
 *
 * HOW "NOTHING WAS STORED" IS PROVEN WITHOUT SQL. It does not need to be observed — it is guaranteed
 * by construction, and the service comment says so: assertValidEvidenceFiles runs over the whole
 * batch BEFORE storage.put is called for any file, precisely so a rejected batch cannot leave some
 * files written and billed. So a 400 from this endpoint is itself the proof, and the tests below
 * assert the 400 and its message. The success path is verified the other way round — uploaded, then
 * downloaded back, then deleted.
 */

const EVIDENCE_MAX_BYTES = 25 * 1024 * 1024;

/*
 * File builders and the multipart body come from utils/uploads.ts rather than being rebuilt here.
 * That module is pure — no database, no tenant — so importing it does not breach this folder's
 * portability rule, and it already encodes the one detail that matters: FilesInterceptor("files", 10)
 * takes a REPEATED `files` field, which Playwright's object form of `multipart` cannot express
 * because it collapses duplicate keys. Hand-rolling indexed keys (`files[0]`, `files[1]`) sends
 * field names the interceptor does not recognise, which fails in a way that looks like a product
 * defect rather than a malformed request.
 */

test.describe("bug evidence validation — reported ticket 10226296533", () => {
  let api: APIRequestContext;
  let projectId: string;
  let bugId: string;
  const uploaded: string[] = [];

  /**
   * POSTs a batch to the bug's evidence route, recording anything it created for teardown.
   *
   * The recording is unconditional and matters more here than in a suite that owns its workspace:
   * on an environment where the validation has not shipped yet, the uploads these tests EXPECT to be
   * refused are accepted instead, and every one of them writes a real file into a shared workspace's
   * storage allowance. Recording only the successes this file intends would leak exactly those.
   */
  async function upload(ctx: APIRequestContext, files: UploadFile[]) {
    const res = await ctx.post(`/api/projects/${projectId}/bugs/${bugId}/attachments`, {
      multipart: filesForm(files),
      failOnStatusCode: false,
    });
    if (res.ok()) {
      const body = await res.json().catch(() => ({}) as { list?: Array<{ id: string }> });
      for (const row of body.list ?? []) uploaded.push(row.id);
    }
    return res;
  }

  test.beforeAll(async () => {
    api = await apiContext();
    projectId = accountA().projectId;
    bugId = (await createBug(api, projectId, { title: unique("Evidence Bug"), severity: "Medium" })).id;
  });

  test.afterAll(async () => {
    // Attachments first: deleting them destroys the stored object as well as the row, which deleting
    // the bug alone would not necessarily do.
    for (const id of uploaded) await api.delete(`/api/bugs/attachments/${id}`, { failOnStatusCode: false });
    await api.delete(`/api/bugs/${bugId}`, { failOnStatusCode: false });
    await api.dispose();
  });

  test(
    ticket("REG-ATT-01", "10226296533", "an unsupported file type is refused, naming the file and what is supported"),
    async () => {
      const name = `malware-${Date.now()}.exe`;
      const res = await upload(api, [{ name, mimeType: "application/octet-stream", body: Buffer.from("MZ") }]);

      expect(res.status(), await res.text()).toBe(400);
      const { error } = await res.json();
      // The reporter has to be able to tell WHICH of several picked files was the problem, and what
      // would have worked — a bare "invalid file" leaves them guessing, which is the state the card
      // was filed from.
      expect(error).toContain(name);
      expect(error).toMatch(/\.exe/);
      expect(error).toMatch(/png/);
    },
  );

  test(
    ticket("REG-ATT-02", "10226296533", "an extensionless file is refused, naming what is supported"),
    async () => {
      /*
       * A deliberate reversal of the endpoint's old behaviour: an extensionless upload used to be
       * accepted and downloadable. The extension is the only thing that tells the server, the browser
       * and the person downloading it what the file is, so evidence with no determinable type is
       * exactly what the card asked to be rejected.
       */
      const res = await upload(api, [
        { name: `noextension-${Date.now()}`, mimeType: "application/octet-stream", body: Buffer.from("x") },
      ]);
      expect(res.status(), await res.text()).toBe(400);
      const { error } = await res.json();
      expect(error).toMatch(/extension/i);
      expect(error).toMatch(/png/);
    },
  );

  test(ticket("REG-ATT-03", "10226296533", "a zero-byte file is refused"), async () => {
    // A zero-byte upload is a failed drag-and-drop or a file still being written; storing it costs
    // an attachment row and a storage key for nothing.
    const res = await upload(api, [sizedFile(`empty-${Date.now()}.png`, 0, "image/png")]);
    expect(res.status(), await res.text()).toBe(400);
    expect((await res.json()).error).toMatch(/empty/i);
  });

  test(
    ticket("REG-ATT-04", "10226296533", "a zip is refused even though it is an ordinary document bundle"),
    async () => {
      // Deliberate, and inherited from the knowledge base's list: an extension check cannot see what
      // is inside an archive, so accepting .zip would accept everything the allowlist just refused.
      const res = await upload(api, [
        { name: `evidence-${Date.now()}.zip`, mimeType: "application/zip", body: Buffer.from("PK") },
      ]);
      expect(res.status(), await res.text()).toBe(400);
    },
  );

  test(
    ticket("REG-ATT-05", "10226296533", "a file over the evidence limit is refused, with the limit in the message"),
    async () => {
      /*
       * The size half of the card, and the one that produced the stuck "Saving…": over the limit but
       * under the interceptor's 100MB, so the request is fully buffered and then refused with a
       * field-level reason rather than dying mid-stream.
       *
       * This genuinely sends ~25MB to the target, which on a remote environment is the slowest test
       * in this folder. It is not reducible: the check runs after multer has buffered the file, so a
       * smaller body would never reach it.
       */
      const name = `huge-${Date.now()}.png`;
      const res = await upload(api, [sizedFile(name, EVIDENCE_MAX_BYTES + 1024, "image/png")]);

      expect(res.status(), await res.text()).toBe(400);
      const { error } = await res.json();
      expect(error).toContain(name);
      expect(error, "the message has to state the ceiling, or the reporter cannot act on it").toContain("25.0MB");
    },
  );

  test(
    ticket("REG-ATT-06", "10226296533", "one bad file in a batch refuses the whole batch"),
    async () => {
      /*
       * The all-or-nothing property the service comment commits to. If validation were per-file and
       * mid-loop, the two PNGs here would be written and billed while the response said 400 — the
       * worst of both outcomes, and invisible without looking in the database.
       */
      const suffix = Date.now();
      const res = await upload(api, [
        pngFile(`good-a-${suffix}.png`),
        { name: `bad-${suffix}.exe`, mimeType: "application/octet-stream", body: Buffer.from("MZ") },
        pngFile(`good-b-${suffix}.png`),
      ]);

      expect(res.status(), await res.text()).toBe(400);
      const body = await res.json();
      expect(body.error).toContain(`bad-${suffix}.exe`);
      // A refused batch carries no created list at all, which is the observable form of "nothing was
      // stored" on an endpoint that has no way to list what it holds.
      expect(body.list, "a refused batch must not report created rows").toBeUndefined();
    },
  );

  test(
    ticket("REG-ATT-07", "10226296533", "a spread of the allowed evidence types is accepted and downloads back"),
    async () => {
      /*
       * The other direction, and what keeps the tests above honest: a validation that refused
       * everything would pass all five of them. Each allowed type is uploaded, then fetched back, so
       * "accepted" means stored and retrievable rather than merely answered 2xx.
       */
      const suffix = Date.now();
      const res = await upload(api, [
        pngFile(`shot-${suffix}.png`),
        { name: `steps-${suffix}.pdf`, mimeType: "application/pdf", body: Buffer.from("%PDF-1.4") },
        { name: `rows-${suffix}.csv`, mimeType: "text/csv", body: Buffer.from("a,b,c") },
      ]);
      expect(res.ok(), `upload failed: ${res.status()} ${await res.text()}`).toBeTruthy();

      const body = await res.json();
      expect(body.list).toHaveLength(3);
      expect(body.total).toBe(3);

      for (const row of body.list) {
        const download = await api.get(`/api/projects/${projectId}/bugs/attachments/${row.id}/download`, {
          failOnStatusCode: false,
        });
        expect(download.ok(), `stored evidence ${row.fileName} did not download`).toBeTruthy();
        // Attacker-supplied content served from the app's own origin must never be rendered.
        expect(download.headers()["content-disposition"]).toContain("attachment");
      }
    },
  );

  test(ticket("REG-ATT-08", "10226296533", "a file at exactly the limit is accepted"), async () => {
    // The boundary itself, from the allowed side. A check written with >= instead of > would refuse
    // a legitimate 25MB screenshot and read to the reporter as the same bug all over again.
    const res = await upload(api, [sizedFile(`limit-${Date.now()}.png`, EVIDENCE_MAX_BYTES, "image/png")]);
    expect(res.ok(), `a file at exactly the limit was refused: ${res.status()} ${await res.text()}`).toBeTruthy();

    /*
     * Compared as a NUMBER after coercion: file_size is a Postgres bigint, and the driver hands
     * bigints back as strings to avoid silently losing precision past 2^53, so the JSON carries
     * "26214400" rather than 26214400. api/attachments.spec.ts reads this column straight out of the
     * database and casts it there, which is why the difference never surfaced until this file asked
     * the API for the same value.
     */
    const body = await res.json();
    expect(Number(body.list?.[0]?.fileSize)).toBe(EVIDENCE_MAX_BYTES);
  });

  test(
    ticket("REG-ATT-09", "10226296533", "an empty submission is refused before any validation runs"),
    async () => {
      const res = await api.post(`/api/projects/${projectId}/bugs/${bugId}/attachments`, {
        multipart: {},
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(400);
      expect((await res.json()).error).toContain("No files");
    },
  );

  test(
    ticket("REG-ATT-10", "10226296533", "evidence cannot be uploaded without a session, or from another tenant"),
    async () => {
      // Uploading bills storage to the workspace's plan allowance, so an unauthenticated or
      // cross-tenant caller reaching this route is a billing problem as well as a privacy one.
      const anon = await anonymousApiContext();
      const other = await apiContextB();
      try {
        const anonRes = await upload(anon, [pngFile(`anon-${Date.now()}.png`)]);
        expect([401, 403], `an unauthenticated upload returned ${anonRes.status()}`).toContain(anonRes.status());

        const otherRes = await upload(other, [pngFile(`tenant-b-${Date.now()}.png`)]);
        expect([403, 404], `account B uploaded into account A's project with ${otherRes.status()}`).toContain(
          otherRes.status(),
        );
      } finally {
        await anon.dispose();
        await other.dispose();
      }
    },
  );
});
