import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  createProject,
  deleteProjects,
  screensApi,
  screensSuiteSkipReason,
  screensTenant,
  uniqueSuffix,
} from "../utils/screens-tenant";

/*
 * The bugs screen at /projects/:id/bugs — specifically the evidence field on the report and edit
 * modals.
 *
 * Basecamp 10226296533 ("[Bug Attachments] Missing File Type and Size Validations Cause Upload to
 * Get Stuck on Saving"). Two halves, both covered here:
 *
 *   1. the picker itself refuses what the server would refuse, the moment the file is chosen, so an
 *      unsupported or oversized file never becomes a request at all;
 *   2. when the server does refuse an upload, the modal says so instead of sitting on "Saving…" —
 *      the throw used to go nowhere, which is what the reporter saw.
 *
 * The server-side rules are covered in api/attachments.spec.ts; this file is about what the person
 * in front of the screen is told.
 */

const tenant = screensTenant();
const skipReason = screensSuiteSkipReason(tenant);

test.use({ storageState: path.join(__dirname, "../.auth/state-screens.json") });

/** The evidence file input, which is hidden behind the "+ Add files" button. */
function fileInput(page: Page) {
  return page.locator('input[type="file"]');
}

async function openReportModal(page: Page, projectId: string): Promise<void> {
  await page.goto(`/projects/${projectId}/bugs`);
  await page.getByRole("button", { name: /report a bug/i }).first().click();
  // The modal renders without role="dialog", so the title is the anchor.
  await expect(page.getByText("Report a Bug", { exact: true })).toBeVisible();
}

test.describe("bug evidence validation", () => {
  let api: APIRequestContext;
  let projectId: string;

  test.beforeAll(async () => {
    if (skipReason) return;
    api = await screensApi();
    const project = await createProject(api);
    projectId = project.id;
  });

  test.afterAll(async () => {
    if (api) {
      await deleteProjects(api, [projectId]);
      await api.dispose();
    }
  });

  test.beforeEach(() => {
    test.skip(skipReason !== null, skipReason ?? "");
  });

  test("BUG-U-01 the picker advertises the types it accepts", async ({ page }) => {
    await openReportModal(page, projectId);
    // Advisory only — the dialog can always be switched to "All files" — but without it the OS
    // picker offers no guidance at all, which is half of why unsupported files were being chosen.
    const accept = await fileInput(page).getAttribute("accept");
    expect(accept, "the evidence input should carry an accept list").toBeTruthy();
    expect(accept).toContain(".png");
    expect(accept).toContain(".pdf");
    expect(accept).not.toContain(".exe");
  });

  test("BUG-U-02 an unsupported file is named and refused without being staged", async ({ page }) => {
    await openReportModal(page, projectId);
    await fileInput(page).setInputFiles({
      name: "malware.exe",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("MZ"),
    });

    const rejections = page.getByTestId("evidence-rejections");
    await expect(rejections).toBeVisible();
    await expect(rejections).toContainText("malware.exe");
    await expect(rejections).toContainText(/\.exe/);
    // Staged files are listed with their size; the rejected one must not appear as one.
    await expect(page.getByText("malware.exe", { exact: true })).toHaveCount(0);
  });

  test("BUG-U-03 an oversized file is refused with the limit, before any upload", async ({ page }) => {
    await openReportModal(page, projectId);

    // Nothing should reach the API: the point of the client-side check is that a 26MB file is never
    // sent, so a request to the attachments endpoint is itself the failure.
    let uploadAttempted = false;
    await page.route("**/bugs/*/attachments", (route) => {
      uploadAttempted = true;
      return route.abort();
    });

    await fileInput(page).setInputFiles({
      name: "recording.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.alloc(26 * 1024 * 1024, 0x61),
    });

    const rejections = page.getByTestId("evidence-rejections");
    await expect(rejections).toBeVisible();
    await expect(rejections).toContainText("recording.mp4");
    await expect(rejections).toContainText("25.0MB");
    expect(uploadAttempted, "an oversized file must not be uploaded before it is rejected").toBeFalsy();
  });

  test("BUG-U-04 a mixed selection keeps the good files and drops only the bad one", async ({ page }) => {
    await openReportModal(page, projectId);
    await fileInput(page).setInputFiles([
      { name: "shot-a.png", mimeType: "image/png", buffer: Buffer.from("a") },
      { name: "notes.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") },
      { name: "shot-b.png", mimeType: "image/png", buffer: Buffer.from("b") },
    ]);

    await expect(page.getByTestId("evidence-rejections")).toContainText("notes.exe");
    // Picking five files and getting one wrong must not discard the other four.
    await expect(page.getByText("shot-a.png")).toBeVisible();
    await expect(page.getByText("shot-b.png")).toBeVisible();
  });

  test("BUG-U-05 a server-side rejection is shown, and the button leaves Saving", async ({ page }) => {
    /*
     * The original defect, reproduced from the other side: the client check is bypassed here (the
     * file is a perfectly valid PNG) and the API is made to refuse the upload. Before the fix the
     * throw was swallowed — the modal stayed open, unchanged, with no message.
     */
    await page.route("**/bugs/*/attachments", (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "shot.png: .png files aren't supported." }),
      }),
    );

    await openReportModal(page, projectId);
    await page.getByPlaceholder("Brief summary of the bug…").fill(`E2E Evidence Failure ${uniqueSuffix()}`);
    await fileInput(page).setInputFiles({
      name: "shot.png",
      mimeType: "image/png",
      buffer: Buffer.from("a"),
    });

    const submit = page.getByRole("button", { name: "Report Bug" });
    await submit.click();

    const error = page.getByTestId("create-bug-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText("aren't supported");
    // And the modal is usable again rather than stuck mid-save.
    await expect(page.getByRole("button", { name: "Report Bug" })).toBeEnabled();
    await expect(page.getByText("Report a Bug", { exact: true })).toBeVisible();
  });
});
