import path from "node:path";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { dbControlAvailable } from "../utils/psql";
import {
  createProject,
  createSuite,
  createTestCase,
  deleteProjects,
  getDashboard,
  listRuns,
  removeWorkspaceMember,
  screensApi,
  screensSuiteSkipReason,
  screensTenant,
  seedRun,
  seedWorkspaceMember,
  uniqueKey,
  uniqueSuffix,
} from "../utils/screens-tenant";

/*
 * The projects list at /projects: creating projects, what the cards report, and the view toggle.
 *
 * Sort, filter and the top-bar search are deliberately absent. Those controls render but are inert
 * — ProjectsToolbar's Sort/Filter are plain buttons with no handler and TopBar's search input has
 * no value/onChange — so there is no behaviour to assert yet. They get specs when they get built.
 *
 * Assertions locate projects by their own unique names rather than by position or count: the
 * project-dashboard API suite creates and deletes projects in this same workspace, and different
 * spec FILES run concurrently, so the list is never guaranteed to hold only this file's fixtures.
 */

const tenant = screensTenant();
const skipReason = screensSuiteSkipReason(tenant);

test.use({ storageState: path.join(__dirname, "../.auth/state-screens.json") });

const VIEW_STORAGE_KEY = "tesbo_projects_view";

/** A project's card in grid view or its row in list view — both are links wrapping the name. */
function projectCard(page: Page, name: string): Locator {
  return page.locator('a[href^="/projects/"]').filter({ hasText: name }).first();
}

/**
 * The number a card shows under a given label.
 *
 * Read structurally (the label div's previous sibling) rather than by CSS class, so a styling
 * change doesn't silently start matching the wrong cell.
 */
async function cardStat(card: Locator, label: string): Promise<string> {
  return card.evaluate((el, wanted) => {
    const labelEl = Array.from(el.querySelectorAll("div")).find(
      (d) => d.textContent?.trim().toLowerCase() === (wanted as string).toLowerCase(),
    );
    return labelEl?.previousElementSibling?.textContent?.trim() ?? "";
  }, label);
}

/** Project names in the order the list renders them. */
async function renderedProjectNames(page: Page): Promise<string[]> {
  return page
    .locator('a[href^="/projects/"]')
    .evaluateAll((links) =>
      links
        .map((l) => l.querySelector("h2")?.textContent?.trim() ?? l.querySelector(".truncate")?.textContent?.trim() ?? "")
        .filter(Boolean),
    );
}

/**
 * Opens the projects list and waits for a specific project's card, reloading if the list came back
 * empty.
 *
 * This retry exists solely because of the defect PRJ-D-22 reports: the per-project stats are
 * gathered with Promise.all and only listTestRuns has a .catch, so if any other spec deletes one of
 * this workspace's projects while the list is mid-load, one 404 rejects the whole batch and the
 * page renders the "No projects yet" onboarding state. Without this, that one bug randomly fails
 * every other test on this screen. Delete this helper when PRJ-D-22 goes green.
 */
async function gotoProjectsAndFind(page: Page, name: string): Promise<Locator> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto("/projects");
    const card = projectCard(page, name);
    if (await card.isVisible({ timeout: 5_000 }).catch(() => false)) return card;
  }
  const card = projectCard(page, name);
  await expect(card, `${name} never appeared in the projects list`).toBeVisible();
  return card;
}

function openCreateModal(page: Page) {
  return page.getByRole("button", { name: /Create project|Create your first project/ }).first().click();
}

/** The create form. Modal.tsx renders without role="dialog", so scope structurally. */
function createForm(page: Page): Locator {
  return page.locator("form").filter({ has: page.locator("#create-name") });
}

test.describe("projects list — creating a project", () => {
  test.skip(!!skipReason, skipReason ?? "");

  let api: APIRequestContext;
  test.beforeAll(async () => {
    api = await screensApi();
  });
  test.afterAll(async () => {
    await api?.dispose();
  });

  test("PRJ-C-01 a name alone is enough, and the new project opens on its dashboard", async ({ page }) => {
    const name = `E2E UI Create ${uniqueSuffix()}`;
    let projectId: string | undefined;
    try {
      await page.goto("/projects");
      await openCreateModal(page);
      await createForm(page).locator("#create-name").fill(name);
      await createForm(page).getByRole("button", { name: "Create project", exact: true }).click();

      await page.waitForURL(/\/projects\/[0-9a-f-]{36}\/dashboard$/);
      projectId = page.url().split("/projects/")[1].split("/")[0];

      const created = await (await api.get(`/api/projects/${projectId}`)).json();
      expect(created.name).toBe(name);
      // The key is derived from the name when none is given.
      expect(created.key).toBeTruthy();
    } finally {
      await deleteProjects(api, [projectId]);
    }
  });

  test("PRJ-C-02 an explicit key and description are persisted verbatim", async ({ page }) => {
    const name = `E2E UI Create Full ${uniqueSuffix()}`;
    const key = uniqueKey("UIC");
    const description = "Created through the projects list UI";
    let projectId: string | undefined;
    try {
      await page.goto("/projects");
      await openCreateModal(page);
      const form = createForm(page);
      await form.locator("#create-name").fill(name);
      await form.locator("#create-key").fill(key);
      await form.locator("#create-desc").fill(description);
      await form.getByRole("button", { name: "Create project", exact: true }).click();

      await page.waitForURL(/\/dashboard$/);
      projectId = page.url().split("/projects/")[1].split("/")[0];

      const created = await (await api.get(`/api/projects/${projectId}`)).json();
      expect(created.name).toBe(name);
      expect(created.key).toBe(key);
      expect(created.description).toBe(description);
    } finally {
      await deleteProjects(api, [projectId]);
    }
  });

  test("PRJ-C-03/07 a new project appears in the list needing setup, with nothing counted yet", async ({
    page,
  }) => {
    const project = await createProject(api);
    try {
      const card = await gotoProjectsAndFind(page, project.name);

      await expect(card).toContainText("Setup required");
      expect(await cardStat(card, "Test cases")).toBe("0");
      // Nothing is seeded into a new project's suites — createProject only seeds knowledge-base
      // folders — so a fresh project genuinely has none.
      expect(await cardStat(card, "Suites")).toBe("0");
      expect(await cardStat(card, "Pass rate")).toBe("—");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-C-06 the ?create=1 deep link opens the modal straight away", async ({ page }) => {
    await page.goto("/projects?create=1");
    await expect(createForm(page).locator("#create-name")).toBeVisible();
  });

  test("PRJ-C-08/09 an empty or whitespace-only name is refused without calling the API", async ({
    page,
  }) => {
    await page.goto("/projects");
    await openCreateModal(page);
    const form = createForm(page);

    let postCount = 0;
    await page.route(
      (url) => url.pathname === "/api/projects",
      (route) => {
        if (route.request().method() === "POST") postCount += 1;
        return route.continue();
      },
    );

    await form.getByRole("button", { name: "Create project", exact: true }).click();
    await expect(form.getByText("Project name is required")).toBeVisible();

    await form.locator("#create-name").fill("   ");
    await form.getByRole("button", { name: "Create project", exact: true }).click();
    await expect(form.getByText("Project name is required")).toBeVisible();

    expect(postCount, "a rejected name must not reach the API").toBe(0);
    await expect(form.locator("#create-name")).toBeVisible();
  });

  test("PRJ-C-10 a duplicate key is reported inline and creates nothing", async ({ page }) => {
    const existing = await createProject(api);
    try {
      await page.goto("/projects");
      await openCreateModal(page);
      const form = createForm(page);
      await form.locator("#create-name").fill(`E2E UI Duplicate ${uniqueSuffix()}`);
      await form.locator("#create-key").fill(existing.key);
      await form.getByRole("button", { name: "Create project", exact: true }).click();

      // The modal stays open carrying the error, rather than navigating or closing silently.
      await expect(form.locator("p.text-red-600")).toBeVisible();
      await expect(page).toHaveURL(/\/projects$/);
    } finally {
      await deleteProjects(api, [existing.id]);
    }
  });

  test("PRJ-C-11 two projects may share a name when their keys differ", async ({ page }) => {
    const sharedName = `E2E UI Shared Name ${uniqueSuffix()}`;
    const first = await createProject(api, { name: sharedName, key: uniqueKey("SHA") });
    let secondId: string | undefined;
    try {
      await page.goto("/projects");
      await openCreateModal(page);
      const form = createForm(page);
      await form.locator("#create-name").fill(sharedName);
      await form.locator("#create-key").fill(uniqueKey("SHB"));
      await form.getByRole("button", { name: "Create project", exact: true }).click();

      await page.waitForURL(/\/dashboard$/);
      secondId = page.url().split("/projects/")[1].split("/")[0];
      expect(secondId).not.toBe(first.id);
    } finally {
      await deleteProjects(api, [first.id, secondId]);
    }
  });

  test("PRJ-C-12 the key field accepts only uppercase alphanumerics as you type", async ({ page }) => {
    await page.goto("/projects");
    await openCreateModal(page);
    const key = createForm(page).locator("#create-key");

    await key.fill("my project-key_1!");
    await expect(key).toHaveValue("MYPROJECTKEY1");
  });

  test("PRJ-C-13 a 255-character name is accepted and a 256-character one is refused", async ({ page }) => {
    const suffix = uniqueSuffix();
    const atLimit = `E2E${suffix}`.padEnd(255, "x");
    let projectId: string | undefined;
    try {
      await page.goto("/projects");
      await openCreateModal(page);
      let form = createForm(page);
      await form.locator("#create-name").fill(atLimit);
      await form.locator("#create-key").fill(uniqueKey("LIM"));
      await form.getByRole("button", { name: "Create project", exact: true }).click();
      await page.waitForURL(/\/dashboard$/);
      projectId = page.url().split("/projects/")[1].split("/")[0];
      expect((await (await api.get(`/api/projects/${projectId}`)).json()).name).toHaveLength(255);

      // One character past the column width must be a refusal, not a silent truncation.
      const overLimit = `E2E${uniqueSuffix()}`.padEnd(256, "y");
      await page.goto("/projects");
      await openCreateModal(page);
      form = createForm(page);
      await form.locator("#create-name").fill(overLimit);
      await form.locator("#create-key").fill(uniqueKey("OVR"));
      await form.getByRole("button", { name: "Create project", exact: true }).click();

      await expect(form.locator("p.text-red-600")).toBeVisible();
      await expect(page).toHaveURL(/\/projects$/);
    } finally {
      await deleteProjects(api, [projectId]);
    }
  });

  test("PRJ-C-14/15 a unicode name round-trips and drives the card's avatar letter", async ({ page }) => {
    const name = `日本語 プロジェクト ${uniqueSuffix()}`;
    const numeric = `9 Lives ${uniqueSuffix()}`;
    const unicodeProject = await createProject(api, { name, key: uniqueKey("UNI") });
    const numericProject = await createProject(api, { name: numeric, key: uniqueKey("NUM") });
    try {
      const unicodeCard = await gotoProjectsAndFind(page, name);
      // charAt(0).toUpperCase() of a non-Latin name is that same character, not a fallback.
      await expect(unicodeCard).toContainText("日");
      await expect(projectCard(page, numeric)).toContainText("9");
    } finally {
      await deleteProjects(api, [unicodeProject.id, numericProject.id]);
    }
  });

  test("PRJ-C-16 cancelling discards what was typed", async ({ page }) => {
    await page.goto("/projects");
    await openCreateModal(page);
    let form = createForm(page);
    await form.locator("#create-name").fill("Abandoned draft");
    await form.getByRole("button", { name: "Cancel" }).click();
    await expect(form.locator("#create-name")).toBeHidden();

    await openCreateModal(page);
    form = createForm(page);
    await expect(form.locator("#create-name")).toHaveValue("");
  });

  test("PRJ-C-18 double-clicking Create makes exactly one project", async ({ page }) => {
    const name = `E2E UI Double ${uniqueSuffix()}`;
    let created: { id: string }[] = [];
    try {
      await page.goto("/projects");
      await openCreateModal(page);
      const form = createForm(page);
      await form.locator("#create-name").fill(name);

      // Hold the response open so the second click lands while the first is still in flight.
      await page.route(
        (url) => url.pathname === "/api/projects",
        async (route) => {
          if (route.request().method() === "POST") await new Promise((r) => setTimeout(r, 800));
          await route.continue();
        },
      );

      const submit = form.getByRole("button", { name: /Create project|Creating/ });
      await submit.click();
      await submit.click({ force: true }).catch(() => undefined);
      await page.waitForURL(/\/dashboard$/, { timeout: 20_000 });

      const all = await (await api.get("/api/projects")).json();
      created = all.filter((p: { name: string }) => p.name === name);
      expect(created).toHaveLength(1);
    } finally {
      await deleteProjects(api, created.map((p) => p.id));
    }
  });

  test("PRJ-C-19 a server error keeps the modal open and creates nothing", async ({ page }) => {
    await page.goto("/projects");
    await openCreateModal(page);
    const form = createForm(page);
    await form.locator("#create-name").fill(`E2E UI Server Error ${uniqueSuffix()}`);

    await page.route(
      (url) => url.pathname === "/api/projects",
      (route) =>
        route.request().method() === "POST"
          ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' })
          : route.continue(),
    );
    await form.getByRole("button", { name: "Create project", exact: true }).click();

    await expect(form.locator("p.text-red-600")).toBeVisible();
    await expect(page).toHaveURL(/\/projects$/);
  });

  test("PRJ-C-20 a dropped connection surfaces an error rather than hanging", async ({ page }) => {
    await page.goto("/projects");
    await openCreateModal(page);
    const form = createForm(page);
    await form.locator("#create-name").fill(`E2E UI Offline ${uniqueSuffix()}`);

    await page.route(
      (url) => url.pathname === "/api/projects",
      (route) => (route.request().method() === "POST" ? route.abort("failed") : route.continue()),
    );
    await form.getByRole("button", { name: "Create project", exact: true }).click();

    await expect(form.locator("p.text-red-600")).toBeVisible();
    // The button must come back — a permanently disabled "Creating…" is a dead end.
    await expect(form.getByRole("button", { name: "Create project", exact: true })).toBeEnabled();
  });

  test("PRJ-C-26 an unauthenticated visitor is sent to the login screen", async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const anonymous = await context.newPage();
      await anonymous.goto("/projects");
      await anonymous.waitForURL("**/login");
    } finally {
      await context.close();
    }
  });

  test("PRJ-C-27 another tenant's projects are not in this list", async ({ page }) => {
    const otherTenantProjects = await (await api.get("/api/projects")).json();
    await page.goto("/projects");
    const rendered = await renderedProjectNames(page);

    // Account A's smoke project lives in a different workspace and must never appear here.
    expect(rendered).not.toContain("E2E Smoke Project");
    expect(otherTenantProjects.every((p: { name: string }) => p.name !== "E2E Smoke Project")).toBe(true);
  });
});

test.describe("projects list — access and the empty state", () => {
  test.skip(!!skipReason, skipReason ?? "");
  test.skip(!dbControlAvailable(), "needs psql access to seed workspace members with specific roles");

  let api: APIRequestContext;
  test.beforeAll(async () => {
    api = await screensApi();
  });
  test.afterAll(async () => {
    await api?.dispose();
  });

  /*
   * These use a freshly seeded member rather than deleting the workspace's projects: the theme and
   * navigation suites read the base project concurrently, and listProjects is scoped by
   * project_members, so a user with no project memberships sees a genuinely empty list without
   * anything being removed.
   */

  test("PRJ-C-04/05/22 a manager with no projects yet is invited to create the first one", async ({
    browser,
  }) => {
    const manager = await seedWorkspaceMember(tenant!.organizationId, "manager");
    const context = await browser.newContext({ storageState: manager.storageStatePath });
    try {
      const page = await context.newPage();
      await page.goto("/projects");

      await expect(page.getByText("No projects yet")).toBeVisible();
      await expect(
        page.getByText("Create a Tesbo Test Manager project for full E2E test management."),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Create your first project" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Create first project" })).toBeVisible();

      // The toolbar has nothing to act on with an empty list, so it isn't rendered at all.
      await expect(page.getByRole("button", { name: "Grid view" })).toHaveCount(0);
    } finally {
      await context.close();
      removeWorkspaceMember(manager.userId, manager.storageStatePath);
    }
  });

  test("PRJ-C-21 a plain member is told to ask for access instead of being offered a button", async ({
    browser,
  }) => {
    const member = await seedWorkspaceMember(tenant!.organizationId, "member");
    const context = await browser.newContext({ storageState: member.storageStatePath });
    try {
      const page = await context.newPage();
      await page.goto("/projects");

      await expect(page.getByText("No projects yet")).toBeVisible();
      await expect(
        page.getByText("You do not have project access yet. Ask your manager to grant access."),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: /Create/ })).toHaveCount(0);
    } finally {
      await context.close();
      removeWorkspaceMember(member.userId, member.storageStatePath);
    }
  });

  test("PRJ-C-23 the server refuses a member who posts around the missing button", async ({ browser }) => {
    const member = await seedWorkspaceMember(tenant!.organizationId, "member");
    const context = await browser.newContext({ storageState: member.storageStatePath });
    try {
      // The button being hidden is presentation. The check that matters is server-side.
      // An explicit key: projectKey() derives from the name and truncates to 16 chars, which cuts
      // the timestamp off this name and collides with the previous run's project.
      const res = await context.request.post(`${process.env.API_BASE_URL}/api/projects`, {
        data: { name: `E2E UI Member Bypass ${uniqueSuffix()}`, key: uniqueKey("BYP") },
        failOnStatusCode: false,
      });
      expect(res.status(), "a workspace member must not be able to create projects").toBe(403);
    } finally {
      await context.close();
      removeWorkspaceMember(member.userId, member.storageStatePath);
    }
  });

  test("PRJ-D-27 a project the caller is not a member of is absent from their list", async ({ browser }) => {
    const admin = await seedWorkspaceMember(tenant!.organizationId, "admin");
    const context = await browser.newContext({ storageState: admin.storageStatePath });
    try {
      const page = await context.newPage();
      await page.goto("/projects");

      // The workspace's base project exists and this user is a workspace admin, but listProjects
      // joins project_members — so workspace-level seniority alone shows them nothing.
      const rendered = await renderedProjectNames(page);
      expect(rendered).toEqual([]);
    } finally {
      await context.close();
      removeWorkspaceMember(admin.userId, admin.storageStatePath);
    }
  });
});

test.describe("projects list — what the cards report", () => {
  test.skip(!!skipReason, skipReason ?? "");

  let api: APIRequestContext;
  test.beforeAll(async () => {
    api = await screensApi();
  });
  test.afterAll(async () => {
    await api?.dispose();
  });

  test("PRJ-D-01/02 the test case and suite counts match the API", async ({ page }) => {
    const project = await createProject(api);
    try {
      await createTestCase(api, project.id);
      await createTestCase(api, project.id);
      await createTestCase(api, project.id);
      await createSuite(api, project.id);

      const summary = await getDashboard(api, project.id);
      const card = await gotoProjectsAndFind(page, project.name);

      expect(await cardStat(card, "Test cases")).toBe(String(summary.testCases.total));
      expect(await cardStat(card, "Suites")).toBe(String(summary.suites));
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-D-03/04 the pass rate and its colour follow the run's result", async ({ page }) => {
    const project = await createProject(api);
    try {
      // 9 of 10 passed = 90%, the boundary where the colour becomes success green.
      await seedRun(api, project.id, {
        statuses: ["Passed", "Passed", "Passed", "Passed", "Passed", "Passed", "Passed", "Passed", "Passed", "Failed"],
        status: "Completed",
      });

      const card = await gotoProjectsAndFind(page, project.name);
      expect(await cardStat(card, "Pass rate")).toBe("90%");

      const colour = await card.evaluate((el) => {
        const label = Array.from(el.querySelectorAll("div")).find(
          (d) => d.textContent?.trim() === "Pass rate",
        );
        const value = label?.previousElementSibling as HTMLElement | null;
        return value ? getComputedStyle(value).color : "";
      });
      // --success, not the warning or error tone.
      expect(colour).not.toBe("");
      expect(colour).not.toBe("rgb(0, 0, 0)");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-D-05/06/07 the status badge tracks setup, configuration and activity", async ({ page }) => {
    const fresh = await createProject(api);
    const configured = await createProject(api);
    try {
      // A project with test cases but no recorded activity reads as Configured; adding a case
      // through the API writes an activity row, which is what flips it to Active.
      await createTestCase(api, configured.id);

      await page.goto("/projects");
      await expect(projectCard(page, fresh.name)).toContainText("Setup required");
      await expect(projectCard(page, configured.name)).toContainText(/Active|Configured/);
    } finally {
      await deleteProjects(api, [fresh.id, configured.id]);
    }
  });

  test("PRJ-D-09 the card's pass rate agrees with the project dashboard", async ({ page }) => {
    const project = await createProject(api);
    try {
      // A finished run, everything passing.
      await seedRun(api, project.id, { statuses: ["Passed", "Passed"], status: "Completed" });
      // Then somebody schedules the next run and hasn't executed it yet.
      await seedRun(api, project.id, { statuses: ["Untested", "Untested"] });

      const summary = await getDashboard(api, project.id);
      const card = await gotoProjectsAndFind(page, project.name);

      /*
       * The dashboard reports 100%: two executions exist, both passed, and Untested is excluded
       * from its denominator. The card divides passed by totalCases of whichever run was created
       * last — `completedRuns` never actually filters on status — so scheduling an empty run drops
       * the same project from 100% to 0% on this screen while the dashboard still says 100%.
       */
      expect(await cardStat(card, "Pass rate")).toBe(`${summary.passRate.value}%`);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-D-10 the card's blocked count is the run's real blocked count", async ({ page }) => {
    const project = await createProject(api);
    try {
      const run = await seedRun(api, project.id, {
        statuses: ["Passed", "Failed", "Untested", "Untested", "Untested"],
        status: "In Progress",
      });
      const listed = (await listRuns(api, project.id)).find((r) => r.id === run.cycleId)!;
      expect(listed.blocked, "nothing in this run is blocked").toBe(0);

      const card = await gotoProjectsAndFind(page, project.name);

      /*
       * listTestRuns already returns a real `blocked` count. The card discards it and recomputes
       * totalCases - passed - failed, which sweeps blocked, skipped, untested and retest into one
       * bucket — so a run with three untested cases reports "3 blocked" here while the project
       * dashboard's own run panel, reading run.blocked, correctly reports none.
       */
      await expect(card).not.toContainText("blocked");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-D-08 the pass-rate bar segments are proportional and omit empty ones", async ({ page }) => {
    const project = await createProject(api);
    try {
      await seedRun(api, project.id, { statuses: ["Passed", "Passed", "Passed", "Failed"], status: "Completed" });

      const card = await gotoProjectsAndFind(page, project.name);
      await expect(card).toContainText("3 passed");
      await expect(card).toContainText("1 failed");
      // The blocked legend entry is rendered only when there is something to report.
      await expect(card).not.toContainText("0 blocked");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-D-12 a project with no members says so rather than showing an empty row", async ({ page }) => {
    const project = await createProject(api);
    try {
      await page.goto("/projects");
      // The creator is added as project owner, so this card has exactly one avatar.
      const card = projectCard(page, project.name);
      await expect(card).not.toContainText("No members assigned");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-D-16 a project with no description shows the guidance placeholder", async ({ page }) => {
    const without = await createProject(api);
    const withDescription = await createProject(api, { description: "A real description" });
    try {
      await page.goto("/projects");

      await expect(projectCard(page, without.name)).toContainText(
        "Add project context to guide test case planning and execution.",
      );
      await expect(projectCard(page, withDescription.name)).toContainText("A real description");
    } finally {
      await deleteProjects(api, [without.id, withDescription.id]);
    }
  });

  test("PRJ-D-15 a project with no activity is labelled by when it was created", async ({ page }) => {
    const project = await createProject(api);
    try {
      await page.goto("/projects");
      await expect(projectCard(page, project.name)).toContainText(/Created .*ago|just now/);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-D-18 the project key is rendered in uppercase", async ({ page }) => {
    const project = await createProject(api, { key: uniqueKey("CAS") });
    try {
      await page.goto("/projects");
      await expect(projectCard(page, project.name)).toContainText(project.key.toUpperCase());
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-D-19 a project's colour is stable across reloads", async ({ page }) => {
    const project = await createProject(api);
    try {
      const avatarColour = async () =>
        projectCard(page, project.name)
          .locator("div")
          .first()
          .evaluate((el) => getComputedStyle(el).backgroundColor);

      await page.goto("/projects");
      const first = await avatarColour();
      await page.reload();
      expect(await avatarColour()).toBe(first);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-D-20 clicking a card opens that project's dashboard", async ({ page }) => {
    const project = await createProject(api);
    try {
      await page.goto("/projects");
      await projectCard(page, project.name).click();
      await page.waitForURL(`**/projects/${project.id}/dashboard`);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-D-21 a project whose runs cannot be fetched still renders", async ({ page }) => {
    const project = await createProject(api);
    try {
      await page.route(
        (url) => /\/api\/projects\/[0-9a-f-]{36}\/cycles$/.test(url.pathname),
        (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }),
      );
      await page.goto("/projects");

      // listTestRuns is caught with .catch(() => []), so the card degrades to "no runs yet".
      const card = projectCard(page, project.name);
      await expect(card).toBeVisible();
      expect(await cardStat(card, "Pass rate")).toBe("—");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-D-22 a failure in one project's stats does not blank the whole list", async ({ page }) => {
    const project = await createProject(api);
    try {
      await page.route(
        (url) => /\/api\/projects\/[0-9a-f-]{36}\/suites$/.test(url.pathname),
        (route) => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }),
      );
      await page.goto("/projects");

      /*
       * The per-project stats are gathered with Promise.all, and only listTestRuns has a .catch —
       * so one failing suites/activity/members call rejects the whole batch, the .finally leaves
       * loading false with projects still empty, and the user is shown the "No projects yet"
       * onboarding state despite having projects. A partial outage should degrade one card.
       */
      await expect(page.getByText("No projects yet")).toHaveCount(0);
      await expect(projectCard(page, project.name)).toBeVisible();
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-D-23 the loading spinner is replaced by content", async ({ page }) => {
    await page.goto("/projects");
    await expect(page.getByText("Loading projects…")).toHaveCount(0);
    await expect(page.getByText("Tesbo Test Manager Projects")).toBeVisible();
  });

  test("PRJ-D-25/26 the list is newest first, and an archived project drops out of it", async ({ page }) => {
    const older = await createProject(api, { name: `E2E UI Order A ${uniqueSuffix()}` });
    const newer = await createProject(api, { name: `E2E UI Order B ${uniqueSuffix()}` });
    try {
      await page.goto("/projects");
      // The list is fetched client-side, so wait for it to paint before reading the order off it.
      await expect(projectCard(page, newer.name)).toBeVisible();

      const names = await renderedProjectNames(page);
      // Asserted as relative order, not absolute position: other suites create projects in this
      // workspace concurrently.
      expect(names.indexOf(newer.name)).toBeGreaterThanOrEqual(0);
      expect(names.indexOf(newer.name)).toBeLessThan(names.indexOf(older.name));

      // DELETE is the archive — deleteProject sets archived_at rather than removing the row, and
      // listProjects filters on archived_at IS NULL.
      await api.delete(`/api/projects/${older.id}`);
      await page.reload();
      await expect(projectCard(page, newer.name)).toBeVisible();
      expect(await renderedProjectNames(page)).not.toContain(older.name);
    } finally {
      await deleteProjects(api, [older.id, newer.id]);
    }
  });

  test("PRJ-D-28 an unexecuted run does not read as a zero-percent pass rate", async ({ page }) => {
    const project = await createProject(api);
    try {
      await seedRun(api, project.id, { statuses: ["Untested", "Untested", "Untested"] });

      const card = await gotoProjectsAndFind(page, project.name);
      // Nothing has been executed, so there is no rate to report — "0%" would be a lie.
      expect(await cardStat(card, "Pass rate")).toBe("—");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });
});

test.describe("projects list — the grid/list toggle", () => {
  test.skip(!!skipReason, skipReason ?? "");

  let api: APIRequestContext;
  test.beforeAll(async () => {
    api = await screensApi();
  });
  test.afterAll(async () => {
    await api?.dispose();
  });

  test("PRJ-V-01/02 grid is the default and List switches the layout", async ({ page }) => {
    await page.goto("/projects");
    await expect(page.getByRole("button", { name: "Grid view" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "List view" })).toHaveAttribute("aria-pressed", "false");

    await page.getByRole("button", { name: "List view" }).click();
    await expect(page.getByRole("button", { name: "List view" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Grid view" })).toHaveAttribute("aria-pressed", "false");
  });

  test("PRJ-V-03 the chosen view is remembered across a reload", async ({ page }) => {
    await page.goto("/projects");
    await page.getByRole("button", { name: "List view" }).click();
    await expect
      .poll(async () => page.evaluate((key) => window.localStorage.getItem(key), VIEW_STORAGE_KEY))
      .toBe("list");

    await page.reload();
    await expect(page.getByRole("button", { name: "List view" })).toHaveAttribute("aria-pressed", "true");
  });

  for (const stored of ["table", "", "{}"]) {
    test(`PRJ-V-04 a corrupt stored view (${JSON.stringify(stored)}) falls back to grid`, async ({ page }) => {
      await page.addInitScript(
        ([key, value]) => window.localStorage.setItem(key as string, value as string),
        [VIEW_STORAGE_KEY, stored] as const,
      );
      await page.goto("/projects");

      await expect(page.getByRole("button", { name: "Grid view" })).toHaveAttribute("aria-pressed", "true");
    });
  }

  test("PRJ-V-05 list view labels every column", async ({ page }) => {
    await page.goto("/projects");
    await page.getByRole("button", { name: "List view" }).click();

    for (const column of ["Project", "Test cases", "Suites", "Pass rate", "Team", "Updated"]) {
      await expect(page.getByText(column, { exact: true }).first()).toBeVisible();
    }
  });

  test("PRJ-V-06/07 both views report the same numbers for the same project", async ({ page }) => {
    const project = await createProject(api);
    try {
      await createTestCase(api, project.id);
      await createTestCase(api, project.id);
      await seedRun(api, project.id, { statuses: ["Passed", "Failed"], status: "Completed" });

      const gridCard = await gotoProjectsAndFind(page, project.name);
      const grid = {
        cases: await cardStat(gridCard, "Test cases"),
        suites: await cardStat(gridCard, "Suites"),
        passRate: await cardStat(gridCard, "Pass rate"),
      };

      await page.getByRole("button", { name: "List view" }).click();
      const row = projectCard(page, project.name);
      const rowText = await row.innerText();

      expect(rowText).toContain(grid.cases);
      expect(rowText).toContain(grid.suites);
      expect(rowText).toContain(grid.passRate);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-V-07 list view says 'No runs yet' where grid shows a dash", async ({ page }) => {
    const project = await createProject(api);
    try {
      await page.goto("/projects");
      await expect(projectCard(page, project.name)).toBeVisible();
      expect(await cardStat(projectCard(page, project.name), "Pass rate")).toBe("—");

      await page.getByRole("button", { name: "List view" }).click();
      await expect(projectCard(page, project.name)).toContainText("No runs yet");
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });

  test("PRJ-V-10 a list row highlights on hover and stays clickable", async ({ page }) => {
    const project = await createProject(api);
    try {
      await page.goto("/projects");
      await page.getByRole("button", { name: "List view" }).click();

      const row = projectCard(page, project.name);
      await row.hover();
      await row.click();
      await page.waitForURL(`**/projects/${project.id}/dashboard`);
    } finally {
      await deleteProjects(api, [project.id]);
    }
  });
});
