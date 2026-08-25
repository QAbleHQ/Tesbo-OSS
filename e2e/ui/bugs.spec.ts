import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  createBug,
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
  // The page's button is "Report Bug"; "Report a Bug" is the MODAL TITLE. Matching the title here
  // waited two minutes for a button that does not exist — the mistake this comment now prevents.
  await page.getByRole("button", { name: "Report Bug" }).first().click();
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

    // Two "Report Bug" buttons exist while the modal is open — the page's and the modal's submit.
    // The submit is the last one in the DOM.
    const submit = page.getByRole("button", { name: "Report Bug" }).last();
    await submit.click();

    const error = page.getByTestId("create-bug-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText("aren't supported");
    // And the modal is usable again rather than stuck mid-save.
    await expect(page.getByRole("button", { name: "Report Bug" }).last()).toBeEnabled();
    await expect(page.getByText("Report a Bug", { exact: true })).toBeVisible();
  });
});

/*
 * The bugs list itself — the row controls, the truncating cells and the filters.
 *
 * Four cards, one screen: 10226234070 ("edit and delete icon size is very small not visible
 * properly") and 10218564160 ("Delete button is not visible") are the same faint-glyph defect from
 * two reporters; 10226229423 ("No tool tip pop up is available for log text") is the truncated and
 * unclamped cells; 10226242373 ("Severity filter is missing") is the filter bar. 10217828537 ("Bug
 * edit pop up is not scrollable") was fixed upstream in components/ui/Modal.tsx and is pinned here
 * so it cannot silently regress.
 */
test.describe("bugs list — controls and filters", () => {
  let api: APIRequestContext;
  let projectId: string;
  // Deliberately contains no word that appears on a control ("list", "board", "edit", "delete"):
  // getByRole name matching is substring-based, so a title mentioning the list view matched the view
  // toggle itself and made every test in this block ambiguous.
  const longTitle =
    "E2E long bug title that must be shortened on screen because it is far too long to sit on one line " +
    "and used to push the whole row to six lines tall with no way to read the rest of it";

  test.beforeAll(async () => {
    if (skipReason) return;
    api = await screensApi();
    const project = await createProject(api);
    projectId = project.id;
    await createBug(api, projectId, { title: `${longTitle} ${uniqueSuffix()}`, severity: "Critical" });
    await createBug(api, projectId, { title: `E2E Low sev bug ${uniqueSuffix()}`, severity: "Low" });
  });

  test.afterAll(async () => {
    if (api) {
      await deleteProjects(api, [projectId]);
      await api.dispose();
    }
  });

  test.beforeEach(async ({ page }) => {
    test.skip(skipReason !== null, skipReason ?? "");
    await page.goto(`/projects/${projectId}/bugs`);
    await page.getByRole("button", { name: "List", exact: true }).click();
    await expect(page.getByRole("columnheader", { name: "Severity" })).toBeVisible();
  });

  test("BUG-U-06 the row's edit and delete controls are labelled and legibly sized", async ({ page }) => {
    const edit = page.getByRole("button", { name: "Edit bug" }).first();
    const del = page.getByRole("button", { name: "Delete bug" }).first();

    // Present and reachable at all — 10218564160 was filed because the delete control read as empty
    // space on the production theme.
    await expect(edit).toBeVisible();
    await expect(del).toBeVisible();

    for (const control of [edit, del]) {
      const box = await control.boundingBox();
      expect(box, "an icon control with no box is not on screen").toBeTruthy();
      // A 32px target with an 18px glyph inside it; the old pairing was 16px in a transparent box.
      expect(box!.height).toBeGreaterThanOrEqual(28);
      expect(box!.width).toBeGreaterThanOrEqual(28);
      const svg = control.locator("svg").first();
      const svgBox = await svg.boundingBox();
      expect(svgBox!.height, "the glyph itself has to be big enough to read").toBeGreaterThanOrEqual(17);
    }

    // The destructive one must not look identical to the safe one.
    const editColor = await edit.evaluate((el) => getComputedStyle(el).color);
    const deleteColor = await del.evaluate((el) => getComputedStyle(el).color);
    expect(deleteColor, "delete should be distinguishable from edit by colour").not.toBe(editColor);
  });

  test("BUG-U-07 a long title is clamped and carries its full text as a tooltip", async ({ page }) => {
    const title = page.locator("td span[title]").filter({ hasText: "E2E long bug title" }).first();
    await expect(title).toBeVisible();

    const tooltip = await title.getAttribute("title");
    expect(tooltip, "the full title has to be readable somehow").toContain("no way to read the rest of it");

    // Clamped: the rendered height is a couple of lines, not the eight the raw string would take.
    const box = await title.boundingBox();
    const lineHeight = await title.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 20);
    expect(box!.height, "the title cell should be clamped, not six lines tall").toBeLessThanOrEqual(lineHeight * 2.6);
  });

  test("BUG-U-08 the severity filter narrows the list and clears back", async ({ page }) => {
    const rows = page.locator("tbody tr");
    const before = await rows.count();
    expect(before, "the fixture seeds two bugs of different severities").toBeGreaterThanOrEqual(2);

    await page.getByLabel("Filter by severity").selectOption("Critical");
    await expect(page.getByText("E2E Low sev bug")).toHaveCount(0);
    await expect(rows).toHaveCount(1);
    await expect(page.locator("tbody").getByText("Critical").first()).toBeVisible();

    await page.getByLabel("Filter by severity").selectOption("");
    await expect(rows).toHaveCount(before);
  });

  test("BUG-U-09 the severity filter is available on the board too", async ({ page }) => {
    // The board groups by status, so the status filter is deliberately list-only — but "show me the
    // Critical ones" is exactly what the board is for, which is why this one is not gated on the view.
    await page.getByRole("button", { name: "Board", exact: true }).click();
    const severity = page.getByLabel("Filter by severity");
    await expect(severity).toBeVisible();

    await severity.selectOption("Low");
    await expect(page.getByText("E2E long bug title")).toHaveCount(0);
  });

  test("BUG-U-10 the edit modal scrolls to its own footer instead of the page behind it", async ({ page }) => {
    /*
     * Basecamp 10217828537 — "Bug edit pop up is not scrollable thus not able to update bug". Fixed
     * upstream in components/ui/Modal.tsx (dev commit e95da92) by locking the app-shell scroller and
     * putting the overflow on the dialog body; pinned here because it is a shared component and the
     * failure mode — a Save button you cannot reach — silently blocks every edit on the screen.
     */
    await page.getByRole("button", { name: "Edit bug" }).first().click();
    await expect(page.getByText("Edit Bug", { exact: true })).toBeVisible();

    // The shell behind the dialog is locked while it is open.
    const shellLocked = await page.evaluate(() => getComputedStyle(document.documentElement).overflow);
    expect(shellLocked).toBe("hidden");

    // And the footer is reachable inside the dialog.
    const save = page.getByRole("button", { name: "Save Changes" });
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeVisible();
    await expect(save).toBeEnabled();
  });
});

/*
 * Bug priority on the screen — Basecamp 10226247009.
 *
 * The card asked for the field on the report form. A field you can set and never see afterwards is
 * not a field, so the column and the edit round trip are covered here too. The API side (validation,
 * clearing, case handling) lives in api/bugs.spec.ts.
 */
test.describe("bug priority", () => {
  let api: APIRequestContext;
  let projectId: string;
  let triagedTitle: string;
  let untriagedTitle: string;

  test.beforeAll(async () => {
    if (skipReason) return;
    api = await screensApi();
    const project = await createProject(api);
    projectId = project.id;
    const suffix = uniqueSuffix();
    triagedTitle = `E2E Triaged bug ${suffix}`;
    untriagedTitle = `E2E Untriaged bug ${suffix}`;
    // Seeded through the API rather than the modal: this project has no runs, and driving the form
    // here would be testing the link picker rather than the priority field.
    await api.post(`/api/projects/${projectId}/bugs`, {
      data: { title: triagedTitle, severity: "High", priority: "P1" },
    });
    await api.post(`/api/projects/${projectId}/bugs`, { data: { title: untriagedTitle, severity: "Low" } });
  });

  test.afterAll(async () => {
    if (api) {
      await deleteProjects(api, [projectId]);
      await api.dispose();
    }
  });

  test.beforeEach(async ({ page }) => {
    test.skip(skipReason !== null, skipReason ?? "");
    await page.goto(`/projects/${projectId}/bugs`);
    await page.getByRole("button", { name: "List", exact: true }).click();
    await expect(page.getByRole("columnheader", { name: "Priority" })).toBeVisible();
  });

  test("BUG-U-11 the list shows a priority per bug, and an em dash when untriaged", async ({ page }) => {
    const triagedRow = page.locator("tbody tr").filter({ hasText: triagedTitle });
    await expect(triagedRow.getByText("P1", { exact: true })).toBeVisible();

    // Untriaged reads as an em dash, not as an invented P2 — the two are different facts.
    const untriagedRow = page.locator("tbody tr").filter({ hasText: untriagedTitle });
    await expect(untriagedRow.getByText("—", { exact: true }).first()).toBeVisible();
    await expect(untriagedRow.getByText(/^P[0-3]$/)).toHaveCount(0);
  });

  test("BUG-U-12 the report form offers priority, defaulting to not set", async ({ page }) => {
    await page.getByRole("button", { name: /report a bug/i }).first().click();
    await expect(page.getByText("Report a Bug", { exact: true })).toBeVisible();

    const priority = page.getByLabel("Bug priority");
    await expect(priority).toBeVisible();
    // Optional by design: "not triaged yet" has to be expressible on the form itself.
    await expect(priority).toHaveValue("");
    await expect(priority.locator("option")).toHaveCount(5);
    for (const value of ["P0", "P1", "P2", "P3"]) {
      await expect(priority.locator(`option[value="${value}"]`)).toHaveCount(1);
    }
  });

  test("BUG-U-13 editing a bug changes its priority and can clear it again", async ({ page }) => {
    const row = page.locator("tbody tr").filter({ hasText: triagedTitle });
    await row.getByRole("button", { name: "Edit bug" }).click();

    const priority = page.getByLabel("Bug priority");
    await expect(priority).toHaveValue("P1");
    await priority.selectOption("P0");
    await page.getByRole("button", { name: "Save Changes" }).click();

    await expect(row.getByText("P0", { exact: true })).toBeVisible();

    // And back to untriaged, which the API expresses as an explicit null rather than an omission.
    await row.getByRole("button", { name: "Edit bug" }).click();
    await page.getByLabel("Bug priority").selectOption("");
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(row.getByText(/^P[0-3]$/)).toHaveCount(0);
  });
});
