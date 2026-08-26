import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { accountA, apiContext, createBug, ticket, unique } from "../fixtures";

/*
 * Reported-ticket regressions for the bugs screen at /projects/:id/bugs.
 *
 *   10226234070 / edit and delete icon size is very small, not visible properly
 *   10218564160 / bug list view: delete button is not visible
 *   10226229423 / list view: no tooltip pop-up is available for log text
 *   10226242373 / severity filter is missing
 *   10217828537 / bug edit pop-up is not scrollable, so the bug cannot be updated
 *   10226247009 / bug priority field is missing when adding a bug from the bug page
 *   10226296533 / missing file type and size validations leave the upload stuck on "Saving"
 *
 * WHY THESE ARE HERE AND NOT IN ui/bugs.spec.ts, WHICH ALREADY COVERS THEM. That file is pinned to
 * `.auth/state-screens.json` and builds its fixtures with screens-tenant's createProject(), which
 * needs the disposable screens tenant global-setup puts on Pro through psql. On a deployed
 * environment there is no database handed out, so the tenant is never provisioned, screensSuiteSkipReason
 * is non-null and every one of those describes skips itself — the cover is dark exactly where the
 * bugs were reported. Everything below is the same behaviour asserted over HTTP as account A.
 *
 * THE COST OF THAT, AND HOW IT IS PAID. Account A's project is shared with the rest of the suite and
 * carries whatever bugs previous runs left behind, so no assertion here may count rows project-wide.
 * Every test narrows the screen to its own fixtures through the "Search bugs…" box first — the page
 * filters on a title substring (page.tsx `filtered`) — and asserts inside that narrowed set.
 */

const SEARCH = "Search bugs…";

/** Opens the bugs list in List view, narrowed to `term`, and waits for the table to settle. */
async function openListFilteredTo(page: Page, projectId: string, term: string): Promise<void> {
  await page.goto(`/projects/${projectId}/bugs`);
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.getByRole("columnheader", { name: "Severity" })).toBeVisible();
  await page.getByPlaceholder(SEARCH).fill(term);
  // The search is a client-side filter over an already-loaded list, so the row count settling is
  // the signal that it has applied — there is no request to wait for.
  await expect(page.locator("tbody tr")).toHaveCount(2);
}

test.describe("bugs list — controls, filters and the edit modal", () => {
  let api: APIRequestContext;
  let projectId: string;
  let token: string;
  let longTitle: string;
  let lowTitle: string;
  const created: string[] = [];

  /*
   * Deliberately contains no word that appears on a control ("list", "board", "edit", "delete"):
   * getByRole name matching is substring-based, and a title mentioning the list view matched the
   * view toggle itself — an ambiguity that reads as a broken locator rather than a broken title.
   */
  const LONG =
    "E2E REG long bug title that must be shortened on screen because it is far too long to sit on one " +
    "line and used to push the whole row to six lines tall with no way to read the rest of it";

  test.beforeAll(async () => {
    api = await apiContext();
    projectId = accountA().projectId;
    token = unique("BugList").split(" ").slice(-1)[0];
    longTitle = `${LONG} ${token}`;
    lowTitle = `E2E REG Low sev bug ${token}`;
    created.push((await createBug(api, projectId, { title: longTitle, severity: "Critical", priority: "P1" })).id);
    created.push((await createBug(api, projectId, { title: lowTitle, severity: "Low" })).id);
  });

  test.afterAll(async () => {
    for (const id of created) await api.delete(`/api/bugs/${id}`, { failOnStatusCode: false });
    await api.dispose();
  });

  test.beforeEach(async ({ page }) => {
    await openListFilteredTo(page, projectId, token);
  });

  test(
    ticket("REG-BUG-01", "10226234070", "the row's edit and delete controls are labelled and legibly sized"),
    async ({ page }) => {
      // Also covers 10218564160 — "delete button is not visible" is the same faint-glyph defect
      // from a second reporter, and a fix that enlarged only the edit control would pass a test
      // that looked at one of them.
      const edit = page.getByRole("button", { name: "Edit bug" }).first();
      const del = page.getByRole("button", { name: "Delete bug" }).first();

      await expect(edit).toBeVisible();
      await expect(del).toBeVisible();

      for (const [label, control] of [["edit", edit], ["delete", del]] as const) {
        const box = await control.boundingBox();
        expect(box, `the ${label} control has no box, so it is not on screen`).toBeTruthy();
        // A 32px target with an 18px glyph inside it; the reported pairing was 16px in a
        // transparent box, which is below every touch-target guideline as well as being hard to see.
        expect(box!.height, `${label} target height`).toBeGreaterThanOrEqual(28);
        expect(box!.width, `${label} target width`).toBeGreaterThanOrEqual(28);
        const svgBox = await control.locator("svg").first().boundingBox();
        expect(svgBox!.height, `the ${label} glyph itself has to be big enough to read`).toBeGreaterThanOrEqual(17);
      }

      // The destructive control must not look identical to the safe one sitting next to it.
      const editColor = await edit.evaluate((el) => getComputedStyle(el).color);
      const deleteColor = await del.evaluate((el) => getComputedStyle(el).color);
      expect(deleteColor, "delete should be distinguishable from edit by colour").not.toBe(editColor);
    },
  );

  test(
    ticket("REG-BUG-02", "10218564160", "the delete control is a real target, not empty space"),
    async ({ page }) => {
      /*
       * Filed separately from 10226234070 and kept as its own test because the reporter's complaint
       * was different: not "too small" but "not visible at all". The distinguishing assertion is
       * that the control has a non-transparent rendered presence and an accessible name — a glyph
       * that inherits the row background is exactly what "not visible" looked like.
       */
      const del = page.getByRole("button", { name: "Delete bug" }).first();
      await expect(del).toBeVisible();
      await expect(del).toBeEnabled();

      const color = await del.evaluate((el) => getComputedStyle(el).color);
      expect(color, "a fully transparent glyph is the reported defect").not.toMatch(/rgba\(.*,\s*0\)$/);

      // And it is reachable by keyboard, which "invisible" controls usually are not.
      await del.focus();
      await expect(del).toBeFocused();
    },
  );

  test(
    ticket("REG-BUG-03", "10226229423", "a long title is clamped and carries its full text as a tooltip"),
    async ({ page }) => {
      const title = page.locator("td span[title]").filter({ hasText: "E2E REG long bug title" }).first();
      await expect(title).toBeVisible();

      const tooltip = await title.getAttribute("title");
      expect(tooltip, "the full title has to be readable somehow").toContain("no way to read the rest of it");

      // Clamped: the rendered height is a couple of lines, not the eight the raw string would take.
      const box = await title.boundingBox();
      const lineHeight = await title.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 20);
      expect(box!.height, "the title cell should be clamped, not six lines tall").toBeLessThanOrEqual(lineHeight * 2.6);
    },
  );

  test(
    ticket("REG-BUG-04", "10226242373", "the severity filter narrows the list and clears back"),
    async ({ page }) => {
      const rows = page.locator("tbody tr");
      // The search has already narrowed the shared project to this test's two fixtures, so these
      // counts are about the fixtures and not about the project.
      await expect(rows).toHaveCount(2);

      await page.getByLabel("Filter by severity").selectOption("Critical");
      await expect(page.getByText(lowTitle)).toHaveCount(0);
      await expect(rows).toHaveCount(1);

      await page.getByLabel("Filter by severity").selectOption("");
      await expect(rows).toHaveCount(2);
    },
  );

  test(
    ticket("REG-BUG-05", "10226242373", "the severity filter is available on the board too"),
    async ({ page }) => {
      // The board groups by status, so the status filter is deliberately list-only — but "show me
      // the Critical ones" is exactly what the board is for, which is why this is not view-gated.
      await page.getByRole("button", { name: "Board", exact: true }).click();
      const severity = page.getByLabel("Filter by severity");
      await expect(severity).toBeVisible();

      await severity.selectOption("Low");
      await expect(page.getByText("E2E REG long bug title")).toHaveCount(0);
      await expect(page.getByText(lowTitle)).toBeVisible();
    },
  );

  test(
    ticket("REG-BUG-06", "10217828537", "the edit modal scrolls to its own footer instead of the page behind it"),
    async ({ page }) => {
      /*
       * "Bug edit pop up is not scrollable thus not able to update bug". Fixed upstream in
       * components/ui/Modal.tsx by locking the app-shell scroller and putting the overflow on the
       * dialog body. Pinned here because it is a SHARED component: the failure mode is a Save button
       * you cannot reach, which silently blocks every edit on the screen and would be re-reported
       * against whichever modal someone happened to open next.
       */
      await page.getByRole("button", { name: "Edit bug" }).first().click();
      await expect(page.getByText("Edit Bug", { exact: true })).toBeVisible();

      // The shell behind the dialog is locked while it is open.
      const shellLocked = await page.evaluate(() => getComputedStyle(document.documentElement).overflow);
      expect(shellLocked, "the page behind the modal must not be the thing that scrolls").toBe("hidden");

      // And the footer is reachable inside the dialog.
      const save = page.getByRole("button", { name: "Save Changes" });
      await save.scrollIntoViewIfNeeded();
      await expect(save).toBeVisible();
      await expect(save).toBeEnabled();
    },
  );
});

/*
 * Bug priority — Basecamp 10226247009.
 *
 * The card asked for the field on the report form. A field you can set and never see afterwards is
 * not a field, so the column and the edit round trip are covered too. The API side (validation,
 * clearing, case handling) is in api/bugs.spec.ts, which is HTTP-only and so already runs here.
 */
test.describe("bug priority on the screen", () => {
  let api: APIRequestContext;
  let projectId: string;
  let token: string;
  let triagedTitle: string;
  let untriagedTitle: string;
  const created: string[] = [];

  test.beforeAll(async () => {
    api = await apiContext();
    projectId = accountA().projectId;
    token = unique("BugPrio").split(" ").slice(-1)[0];
    triagedTitle = `E2E REG Triaged bug ${token}`;
    untriagedTitle = `E2E REG Untriaged bug ${token}`;
    // Seeded through the API rather than the modal: driving the form here would be testing the
    // link picker rather than the priority field.
    created.push((await createBug(api, projectId, { title: triagedTitle, severity: "High", priority: "P1" })).id);
    created.push((await createBug(api, projectId, { title: untriagedTitle, severity: "Low" })).id);
  });

  test.afterAll(async () => {
    for (const id of created) await api.delete(`/api/bugs/${id}`, { failOnStatusCode: false });
    await api.dispose();
  });

  test.beforeEach(async ({ page }) => {
    await openListFilteredTo(page, projectId, token);
    await expect(page.getByRole("columnheader", { name: "Priority" })).toBeVisible();
  });

  test(
    ticket("REG-BUG-07", "10226247009", "the list shows a priority per bug, and an em dash when untriaged"),
    async ({ page }) => {
      const triagedRow = page.locator("tbody tr").filter({ hasText: triagedTitle });
      await expect(triagedRow.getByText("P1", { exact: true })).toBeVisible();

      // Untriaged reads as an em dash, not as an invented P2 — the two are different facts, and
      // defaulting an untriaged bug into a priority bucket is worse than showing it has none.
      const untriagedRow = page.locator("tbody tr").filter({ hasText: untriagedTitle });
      await expect(untriagedRow.getByText("—", { exact: true }).first()).toBeVisible();
      await expect(untriagedRow.getByText(/^P[0-3]$/)).toHaveCount(0);
    },
  );

  test(
    ticket("REG-BUG-08", "10226247009", "the report form offers priority, defaulting to not set"),
    async ({ page }) => {
      await page.getByRole("button", { name: /report a bug/i }).first().click();
      await expect(page.getByText("Report a Bug", { exact: true })).toBeVisible();

      const priority = page.getByLabel("Bug priority");
      await expect(priority).toBeVisible();
      // Optional by design: "not triaged yet" has to be expressible on the form itself, which is
      // why the empty option is present and selected rather than the form defaulting to P2.
      await expect(priority).toHaveValue("");
      await expect(priority.locator("option")).toHaveCount(5);
      for (const value of ["P0", "P1", "P2", "P3"]) {
        await expect(priority.locator(`option[value="${value}"]`)).toHaveCount(1);
      }
    },
  );

  test(
    ticket("REG-BUG-09", "10226247009", "editing a bug changes its priority and can clear it again"),
    async ({ page }) => {
      const row = page.locator("tbody tr").filter({ hasText: triagedTitle });
      await row.getByRole("button", { name: "Edit bug" }).click();

      const priority = page.getByLabel("Bug priority");
      await expect(priority).toHaveValue("P1");
      await priority.selectOption("P0");
      await page.getByRole("button", { name: "Save Changes" }).click();

      await expect(row.getByText("P0", { exact: true })).toBeVisible();

      // And back to untriaged, which the API expresses as an explicit null rather than an omission —
      // asserted on the persisted record, not only on the cell, because a cell that clears while the
      // row keeps its old priority is the bug this is guarding.
      await row.getByRole("button", { name: "Edit bug" }).click();
      await page.getByLabel("Bug priority").selectOption("");
      await page.getByRole("button", { name: "Save Changes" }).click();
      await expect(row.getByText(/^P[0-3]$/)).toHaveCount(0);

      const persisted = await (await api.get(`/api/projects/${projectId}/bugs`)).json();
      const record = (persisted.items ?? persisted).find((b: { title: string }) => b.title === triagedTitle);
      expect(record?.priority ?? null, "clearing the field on screen must clear it in the record").toBeNull();
    },
  );
});

/*
 * Bug evidence validation — Basecamp 10226296533.
 *
 * Two halves, both here: the picker refuses what the server would refuse the moment the file is
 * chosen, so an unsupported or oversized file never becomes a request; and when the server does
 * refuse, the modal says so instead of sitting on "Saving…" — the throw used to go nowhere, which
 * is what the reporter saw. The server-side rules themselves are in
 * regression/api/tickets-attachments.spec.ts.
 *
 * Nothing in this block creates a bug: every test either stops at the picker or intercepts the
 * upload, so it leaves account A's shared project untouched.
 */
test.describe("bug evidence validation", () => {
  const projectId = () => accountA().projectId;

  /*
   * The evidence file input, which is hidden behind the "+ Add files" button.
   *
   * The ancestor exclusion is not decoration. A deployed environment has the BetterBugs recorder SDK
   * installed — it is how these very tickets were reported — and that SDK mounts its own
   * `<input type="file" accept=".png,.jpg,.jpeg,.pdf">` under `#betterbugs-sdk-main`. A bare
   * `input[type="file"]` therefore resolves to two elements and dies on Playwright's strict-mode
   * check, which reads as a broken product rather than a spec that matched the wrong page furniture.
   * Worse, the SDK's input CARRIES an accept list, so a `.first()` here could pass this test against
   * an app input that has none.
   */
  function fileInput(page: Page) {
    return page
      .locator('input[type="file"]')
      .locator('xpath=self::*[not(ancestor::*[@id="betterbugs-sdk-main"])]');
  }

  async function openReportModal(page: Page): Promise<void> {
    await page.goto(`/projects/${projectId()}/bugs`);
    // The page's button is "Report Bug"; "Report a Bug" is the MODAL TITLE. Matching the title as a
    // button name waits out the timeout for a control that does not exist.
    await page.getByRole("button", { name: "Report Bug" }).first().click();
    // The modal renders without role="dialog", so the title text is the anchor.
    await expect(page.getByText("Report a Bug", { exact: true })).toBeVisible();
  }

  test(
    ticket("REG-BUG-10", "10226296533", "the picker advertises the types it accepts"),
    async ({ page }) => {
      await openReportModal(page);
      // Advisory only — the OS dialog can always be switched to "All files" — but without it the
      // picker offers no guidance at all, which is half of why unsupported files were being chosen.
      const accept = await fileInput(page).getAttribute("accept");
      expect(accept, "the evidence input should carry an accept list").toBeTruthy();
      expect(accept).toContain(".png");
      expect(accept).toContain(".pdf");
      expect(accept).not.toContain(".exe");
    },
  );

  test(
    ticket("REG-BUG-11", "10226296533", "an unsupported file is named and refused without being staged"),
    async ({ page }) => {
      await openReportModal(page);
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
    },
  );

  test(
    ticket("REG-BUG-12", "10226296533", "an oversized file is refused with the limit, before any upload"),
    async ({ page }) => {
      await openReportModal(page);

      // Nothing should reach the API: the point of the client-side check is that a 26MB file is
      // never sent, so a request to the attachments endpoint is itself the failure.
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
    },
  );

  test(
    ticket("REG-BUG-13", "10226296533", "a mixed selection keeps the good files and drops only the bad one"),
    async ({ page }) => {
      await openReportModal(page);
      await fileInput(page).setInputFiles([
        { name: "shot-a.png", mimeType: "image/png", buffer: Buffer.from("a") },
        { name: "notes.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") },
        { name: "shot-b.png", mimeType: "image/png", buffer: Buffer.from("b") },
      ]);

      await expect(page.getByTestId("evidence-rejections")).toContainText("notes.exe");
      // Picking five files and getting one wrong must not discard the other four.
      await expect(page.getByText("shot-a.png")).toBeVisible();
      await expect(page.getByText("shot-b.png")).toBeVisible();
    },
  );

  test(
    ticket("REG-BUG-14", "10226296533", "a server-side rejection is shown, and the button leaves Saving"),
    async ({ page }) => {
      /*
       * The original defect, reproduced from the other side: the client check is bypassed here (the
       * file is a perfectly valid PNG) and the API is made to refuse the upload. Before the fix the
       * throw was swallowed — the modal stayed open, unchanged, with no message, which is precisely
       * "stuck on Saving". Intercepting means no bug is actually created in the shared project.
       */
      await page.route("**/bugs/*/attachments", (route) =>
        route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "shot.png: .png files aren't supported." }),
        }),
      );

      await openReportModal(page);
      await page.getByPlaceholder("Brief summary of the bug…").fill(unique("Evidence Failure"));
      await fileInput(page).setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: Buffer.from("a") });

      // Two "Report Bug" buttons exist while the modal is open — the page's and the modal's submit.
      // The submit is the last one in the DOM.
      await page.getByRole("button", { name: "Report Bug" }).last().click();

      const error = page.getByTestId("create-bug-error");
      await expect(error).toBeVisible();
      await expect(error).toContainText("aren't supported");
      // And the modal is usable again rather than stuck mid-save.
      await expect(page.getByRole("button", { name: "Report Bug" }).last()).toBeEnabled();
      await expect(page.getByText("Report a Bug", { exact: true })).toBeVisible();
    },
  );
});
