import { expect, test } from "@playwright/test";
import { accountA, apiContext, ticket, unique } from "../fixtures";

/*
 * Reported-ticket regressions for Project Settings → Test Environments.
 * Card 10221899361, BetterBugs 6a86cede, filed against .../settings?tab=testRuns.
 *
 * This is one of the few cards in this folder whose fix genuinely shipped, so every test here is a
 * real green assertion rather than an expected-red one. handleAddEnvironment() validates both of the
 * cases the card is about:
 *
 *   !name || !url                 -> "Environment name and URL are required."
 *   name already in the list      -> "Environment name already exists."   (case-insensitive)
 *
 * The screen has TWO steps, which is the thing to get right when reading these tests: **Add** stages
 * an environment into local component state and clears the two inputs; **Save** is what PATCHes the
 * project. So validation is asserted on Add, and persistence on Save. A test that only clicked Save
 * would exercise the half-typed-draft fallback in the submit handler instead of the validation the
 * ticket is actually about.
 *
 * Environments live inside the project's `settings` JSON blob, so persistence is verified against
 * GET /api/projects/:id, never against the on-screen toast — the suite's convention is that a
 * message is not evidence.
 */

test.describe("project settings — test environments", () => {
  const settingsUrl = () => `/projects/${accountA().projectId}/settings?tab=testRuns`;

  const nameInput = "Environment name";
  const urlInput = "https://staging.example.com";

  /*
   * These tests write into account A's real project, shared with the rest of the suite, and Save
   * rewrites the whole environments array rather than appending to it. So the settings blob is
   * captured before each test and restored after, which is both the cleanup and the reason a failed
   * test cannot leave the project altered for whatever runs next.
   */
  /*
   * `captured` is tracked separately from the value itself, and that distinction is load-bearing: a
   * project whose settings column is still NULL — the normal state of a freshly created project, so
   * the likely state on a new environment — would otherwise be indistinguishable from "we never read
   * it", and the restore would be skipped exactly where it is needed. The environments this file adds
   * would then be left behind in a shared project.
   */
  let originalSettings: string | null = null;
  let captured = false;

  test.beforeEach(async () => {
    const api = await apiContext();
    try {
      const project = await (await api.get(`/api/projects/${accountA().projectId}`)).json();
      originalSettings = typeof project.settings === "string" ? project.settings : null;
      captured = true;
    } finally {
      await api.dispose();
    }
  });

  test.afterEach(async () => {
    if (!captured) return;
    const api = await apiContext();
    try {
      await api.patch(`/api/projects/${accountA().projectId}`, {
        // An empty settings object where there was none: this screen's own save path would write one
        // anyway, and it leaves no environment behind, which is the property that matters.
        data: { settings: originalSettings ?? "{}" },
        failOnStatusCode: false,
      });
    } finally {
      await api.dispose();
    }
    captured = false;
  });

  async function storedEnvironments(): Promise<Array<{ name: string; url: string }>> {
    const api = await apiContext();
    try {
      const project = await (await api.get(`/api/projects/${accountA().projectId}`)).json();
      const settings = JSON.parse(String(project.settings ?? "{}"));
      return Array.isArray(settings.testRunEnvironments) ? settings.testRunEnvironments : [];
    } finally {
      await api.dispose();
    }
  }

  test(
    ticket("REG-ENV-01", "10221899361", "adding a name with no URL is refused"),
    async ({ page }) => {
      await page.goto(settingsUrl());

      const name = unique("Env");
      await page.getByPlaceholder(nameInput).fill(name);
      await page.getByRole("button", { name: "Add", exact: true }).click();

      await expect(page.getByText("Environment name and URL are required.")).toBeVisible();
      // Refused means not staged: the name is still in the box, waiting to be completed.
      await expect(page.getByPlaceholder(nameInput)).toHaveValue(name);
    },
  );

  test(
    ticket("REG-ENV-02", "10221899361", "adding a URL with no name is refused"),
    async ({ page }) => {
      await page.goto(settingsUrl());

      await page.getByPlaceholder(urlInput).fill("https://reg-no-name.example.com");
      await page.getByRole("button", { name: "Add", exact: true }).click();

      await expect(page.getByText("Environment name and URL are required.")).toBeVisible();
      await expect(page.getByPlaceholder(urlInput)).toHaveValue("https://reg-no-name.example.com");
    },
  );

  test(
    ticket("REG-ENV-03", "10221899361", "a complete environment stages, saves, and reads back from the API"),
    async ({ page }) => {
      // The happy path, so that a future tightening of the validation cannot start refusing valid
      // input and still pass REG-ENV-01/02.
      await page.goto(settingsUrl());

      const name = unique("Env");
      const url = `https://reg-${Date.now()}.example.com`;

      await page.getByPlaceholder(nameInput).fill(name);
      await page.getByPlaceholder(urlInput).fill(url);
      await page.getByRole("button", { name: "Add", exact: true }).click();

      // Staged: the inputs clear and the row appears in the table above them.
      await expect(page.getByPlaceholder(nameInput)).toHaveValue("");
      await expect(page.getByText(name)).toBeVisible();

      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Project settings saved.")).toBeVisible();

      expect(
        await storedEnvironments(),
        "the saved environment should be readable back from the project",
      ).toEqual(expect.arrayContaining([expect.objectContaining({ name, url })]));
    },
  );

  test(
    ticket("REG-ENV-04", "10221899361", "a duplicate environment name is refused, whatever its casing"),
    async ({ page }) => {
      /*
       * The second validation the fix added. Asserted with a DIFFERENT CASING on purpose: the check
       * is `item.name.toLowerCase() === name.toLowerCase()`, so an assertion that reused the exact
       * same string would still pass if someone replaced it with a plain `===` comparison, and the
       * case-insensitivity — the part that is easy to lose in a refactor — would go untested.
       */
      await page.goto(settingsUrl());

      const name = unique("Env");
      await page.getByPlaceholder(nameInput).fill(name);
      await page.getByPlaceholder(urlInput).fill(`https://first-${Date.now()}.example.com`);
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByPlaceholder(nameInput)).toHaveValue("");

      await page.getByPlaceholder(nameInput).fill(name.toUpperCase());
      await page.getByPlaceholder(urlInput).fill(`https://second-${Date.now()}.example.com`);
      await page.getByRole("button", { name: "Add", exact: true }).click();

      await expect(page.getByText("Environment name already exists.")).toBeVisible();

      // And it really was not staged — saving now must persist exactly one entry for that name.
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Project settings saved.")).toBeVisible();

      const matching = (await storedEnvironments()).filter(
        (e) => e.name.toLowerCase() === name.toLowerCase(),
      );
      expect(matching, "the duplicate must not have been added alongside the original").toHaveLength(1);
    },
  );
});
