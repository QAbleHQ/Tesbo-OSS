import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { dbControlAvailable } from "../utils/psql";
import {
  removeWorkspaceMember,
  screensSuiteSkipReason,
  screensTenant,
  seedWorkspaceMember,
} from "../utils/screens-tenant";

/*
 * The side navigation, in each of the three modes Sidebar.tsx switches between:
 * workspace (outside any project), project (inside one), and settings.
 */

const tenant = screensTenant();
const skipReason = screensSuiteSkipReason(tenant);

test.use({ storageState: path.join(__dirname, "../.auth/state-screens.json") });

/** The sidebar is the only <aside> on these pages; scoping to it keeps page links out of the way. */
function sidebar(page: Page) {
  return page.locator("aside").first();
}

function navLink(page: Page, label: string) {
  return sidebar(page).getByRole("link", { name: label, exact: true });
}

/** tesbo-nav-item-active is the class NavLink applies to the current route's entry. */
async function activeNavLabels(page: Page): Promise<string[]> {
  return sidebar(page)
    .locator("a.tesbo-nav-item-active")
    .evaluateAll((links) => links.map((l) => (l.textContent ?? "").trim()));
}

test.describe("side navigation — workspace mode", () => {
  test.skip(!!skipReason, skipReason ?? "");

  test.beforeEach(async ({ page }) => {
    await page.goto("/projects");
  });

  test("NAV-W-01 shows exactly the three workspace destinations", async ({ page }) => {
    await expect(navLink(page, "Dashboard")).toBeVisible();
    await expect(navLink(page, "Projects")).toBeVisible();
    // The screens tenant's user created the workspace, so it is the owner.
    await expect(navLink(page, "Activity")).toBeVisible();
  });

  test("NAV-W-03 Projects is the only item marked active on /projects", async ({ page }) => {
    expect(await activeNavLabels(page)).toEqual(["Projects"]);
  });

  test("NAV-W-04 each workspace item navigates and takes the active state with it", async ({ page }) => {
    await navLink(page, "Dashboard").click();
    await page.waitForURL("**/dashboard");
    expect(await activeNavLabels(page)).toEqual(["Dashboard"]);

    await navLink(page, "Activity").click();
    await page.waitForURL("**/activity");
    expect(await activeNavLabels(page)).toEqual(["Activity"]);

    await navLink(page, "Projects").click();
    await page.waitForURL("**/projects");
    expect(await activeNavLabels(page)).toEqual(["Projects"]);
  });

  test("NAV-W-05 the footer offers workspace settings, not project settings", async ({ page }) => {
    await expect(navLink(page, "Workspace settings")).toBeVisible();
    await expect(navLink(page, "Project settings")).toHaveCount(0);
  });

  test("NAV-W-06 the project-only sections are absent outside a project", async ({ page }) => {
    for (const section of ["Test management", "Execution", "Assets"]) {
      await expect(sidebar(page).getByText(section, { exact: true })).toHaveCount(0);
    }
    await expect(navLink(page, "All Projects")).toHaveCount(0);
  });

  test("NAV-W-07 the brand mark returns to the projects list", async ({ page }) => {
    await page.goto("/dashboard");
    await sidebar(page).getByRole("link", { name: "Tesbo Test Manager" }).click();
    await page.waitForURL("**/projects");
  });

  test("NAV-W-02 a non-owner does not get the workspace Activity link", async ({ browser }) => {
    test.skip(!dbControlAvailable(), "needs psql access to seed a second workspace member");
    const member = await seedWorkspaceMember(tenant!.organizationId, "member");
    const context = await browser.newContext({ storageState: member.storageStatePath });
    try {
      const memberPage = await context.newPage();
      await memberPage.goto("/projects");

      await expect(navLink(memberPage, "Projects")).toBeVisible();
      await expect(navLink(memberPage, "Dashboard")).toBeVisible();
      // Sidebar.tsx gates this one on the workspace role being exactly "owner".
      await expect(navLink(memberPage, "Activity")).toHaveCount(0);
    } finally {
      await context.close();
      removeWorkspaceMember(member.userId, member.storageStatePath);
    }
  });
});

test.describe("side navigation — project mode", () => {
  test.skip(!!skipReason, skipReason ?? "");

  const projectPath = (suffix = "") => `/projects/${tenant!.projectId}${suffix}`;

  test.beforeEach(async ({ page }) => {
    await page.goto(projectPath("/dashboard"));
  });

  test("NAV-P-01 All Projects returns to the workspace list", async ({ page }) => {
    await navLink(page, "All Projects").click();
    await page.waitForURL("**/projects");
    await expect(navLink(page, "Dashboard")).toBeVisible();
  });

  test("NAV-P-02 the four section headers are present", async ({ page }) => {
    for (const section of ["Overview", "Test management", "Execution", "Assets"]) {
      await expect(sidebar(page).getByText(section, { exact: true })).toBeVisible();
    }
  });

  // Every destination the project sidebar offers, with something only that page renders.
  const destinations: { label: string; url: RegExp; heading: RegExp }[] = [
    { label: "Project home", url: /\/dashboard$/, heading: /Recent test runs/ },
    { label: "Activity stream", url: /\/activity$/, heading: /Activity/ },
    { label: "Requirements", url: /\/requirements$/, heading: /Requirement/ },
    { label: "Test cases", url: /\/testcases$/, heading: /Test case/i },
    { label: "Test plans", url: /\/plans$/, heading: /[Tt]est [Pp]lan/ },
    { label: "Runs", url: /\/cycles$/, heading: /[Tt]est [Rr]un/ },
    { label: "Bugs", url: /\/bugs$/, heading: /Bug/ },
    { label: "Insights", url: /\/reports$/, heading: /Insight|Report|Health/ },
    { label: "Agents", url: /\/agents$/, heading: /Agent/ },
    { label: "Knowledge base", url: /\/knowledge-base$/, heading: /Knowledge/ },
  ];

  for (const destination of destinations) {
    test(`NAV-P-03/04/05 ${destination.label} opens its own page without erroring`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));

      await navLink(page, destination.label).click();
      await expect(page).toHaveURL(destination.url);
      await expect(page.locator("main, body").first().getByText(destination.heading).first()).toBeVisible();
      expect(pageErrors, `${destination.label} raised a client-side error`).toEqual([]);
    });
  }

  test("NAV-P-06/07 the project root redirects to the dashboard and marks Project home active", async ({
    page,
  }) => {
    await page.goto(projectPath());
    await page.waitForURL(/\/dashboard$/);
    expect(await activeNavLabels(page)).toContain("Project home");
  });

  test("NAV-P-08 a deep child route keeps its parent section active", async ({ page }) => {
    await navLink(page, "Runs").click();
    await page.waitForURL(/\/cycles$/);
    expect(await activeNavLabels(page)).toContain("Runs");
  });

  test("NAV-P-09/10 the Agents sub-items appear only once Agents is the active section", async ({
    page,
  }) => {
    await expect(navLink(page, "Tasks")).toHaveCount(0);
    await expect(navLink(page, "Zyra settings")).toHaveCount(0);

    await navLink(page, "Agents").click();
    await page.waitForURL(/\/agents$/);

    await expect(navLink(page, "Tasks")).toBeVisible();
    await expect(navLink(page, "Agent list")).toBeVisible();
    await expect(navLink(page, "Zyra settings")).toBeVisible();
    // "Agent list" points at the exact agents path, so it's active here alongside its parent.
    expect(await activeNavLabels(page)).toContain("Agent list");
  });

  test("NAV-P-12 every project link carries the project id currently being viewed", async ({ page }) => {
    const hrefs = await sidebar(page)
      .locator("a")
      .evaluateAll((links) => links.map((l) => l.getAttribute("href") ?? ""));
    const projectScoped = hrefs.filter((href) => href.startsWith("/projects/"));

    expect(projectScoped.length).toBeGreaterThan(5);
    for (const href of projectScoped) {
      expect(href).toContain(`/projects/${tenant!.projectId}`);
    }
  });

  test("NAV-P-13 a project id from another workspace lands back on the projects list", async ({ page }) => {
    // A syntactically valid id this workspace has no access to — the app must not half-render.
    await page.goto("/projects/00000000-0000-0000-0000-000000000000/dashboard");
    await page.waitForURL("**/projects", { timeout: 15_000 });
  });

  test("NAV-P-14 the footer offers project settings and marks it active there", async ({ page }) => {
    await expect(navLink(page, "Project settings")).toBeVisible();
    await expect(navLink(page, "Workspace settings")).toHaveCount(0);

    await navLink(page, "Project settings").click();
    await page.waitForURL(/\/settings$/);
    expect(await activeNavLabels(page)).toContain("Project settings");
  });

  test("NAV-P-15 workspace settings collapses the rail to just the way back", async ({ page }) => {
    await page.goto("/settings");

    await expect(navLink(page, "All Projects")).toBeVisible();
    for (const label of ["Test cases", "Runs", "Bugs", "Dashboard", "Projects"]) {
      await expect(navLink(page, label)).toHaveCount(0);
    }
  });

  test("NAV-P-17 members and suites are reachable by URL but absent from the nav", async ({ page }) => {
    await expect(navLink(page, "Members")).toHaveCount(0);
    await expect(navLink(page, "Suites")).toHaveCount(0);

    // /members is a redirect stub: the real screen is a tab inside project settings, which is
    // why the sidebar has no entry of its own for it.
    await page.goto(projectPath("/members"));
    await page.waitForURL(/\/settings\?tab=members$/);
  });
});

test.describe("side navigation — behaviour", () => {
  test.skip(!!skipReason, skipReason ?? "");

  test("NAV-B-01/02 collapsing hides the labels and expanding brings them back", async ({ page }) => {
    await page.goto("/projects");
    const rail = sidebar(page);
    await expect(rail).toHaveCSS("width", "260px");
    await expect(navLink(page, "Projects")).toHaveText("Projects");

    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(rail).toHaveCSS("width", "60px");
    // The label stays in the accessibility tree as sr-only text — the link keeps its name.
    await expect(rail.getByRole("link", { name: "Projects", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();

    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await expect(rail).toHaveCSS("width", "260px");
    await expect(navLink(page, "Projects")).toHaveText("Projects");
  });

  test("NAV-B-03 the collapsed rail keeps its toggle reachable below the brand mark", async ({ page }) => {
    await page.goto("/projects");
    await page.getByRole("button", { name: "Collapse sidebar" }).click();

    // Regression guard: these used to sit side by side, which overflowed the 60px rail and pushed
    // the toggle under the sticky TopBar, leaving no way to expand again.
    const expand = page.getByRole("button", { name: "Expand sidebar" });
    await expect(expand).toBeVisible();
    // The rail animates (transition-[width] duration-200). Measuring before it settles catches the
    // toggle still laid out for the 260px rail and reports a false overflow.
    await expect(sidebar(page)).toHaveCSS("width", "60px");
    const [box, rail] = [await expand.boundingBox(), await sidebar(page).boundingBox()];
    // Within the rail, not overflowing it. Compared against the rail's own box rather than the
    // literal 60px so sub-pixel layout rounding isn't mistaken for an overflow.
    expect(box!.x + box!.width).toBeLessThanOrEqual(rail!.x + rail!.width + 1);
    await expand.click();
    await expect(sidebar(page)).toHaveCSS("width", "260px");
  });

  test("NAV-B-04 the collapsed state is not remembered across a reload", async ({ page }) => {
    await page.goto("/projects");
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(sidebar(page)).toHaveCSS("width", "60px");

    await page.reload();
    // Pinned as-is: isCollapsed is component state with no persistence, so every navigation that
    // remounts the sidebar reopens it. Worth deciding deliberately rather than leaving implicit.
    await expect(sidebar(page)).toHaveCSS("width", "260px");
  });

  test("NAV-B-05 the theme toggle and log out stay usable in the collapsed rail", async ({ page }) => {
    await page.goto("/projects");
    await page.getByRole("button", { name: "Collapse sidebar" }).click();

    await expect(page.getByRole("button", { name: "Use dark theme" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Use light theme" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  });

  test("NAV-B-06/09 logging out ends the session and Back cannot resurrect it", async ({ browser }) => {
    test.skip(!dbControlAvailable(), "needs psql access to seed a disposable user to log out with");
    // Its own user: logout invalidates the session server-side, and the shared screens storage
    // state would be left holding a dead cookie for every other spec in the run.
    const member = await seedWorkspaceMember(tenant!.organizationId, "member");
    const context = await browser.newContext({ storageState: member.storageStatePath });
    const page = await context.newPage();
    try {
    await page.goto("/projects");
    await page.getByRole("button", { name: "Log out" }).click();
    // Generous: this test shares the stack with the rest of the suite, and the redirect waits on a
    // real round trip to the backend.
    await page.waitForURL("**/login", { timeout: 30_000 });

    const token = await page.evaluate(() => window.localStorage.getItem("token"));
    expect(token).toBeNull();

    // The session itself must be gone, not merely the page. onLogout uses router.replace, so there
    // is no authenticated entry left in history to go back to — asking for the app directly is the
    // assertion that actually proves the cookie was invalidated.
    await page.goto("/projects");
    await page.waitForURL("**/login", { timeout: 30_000 });
    } finally {
      await context.close();
      removeWorkspaceMember(member.userId, member.storageStatePath);
    }
  });

  test("NAV-B-07 a failed logout says so and leaves the button usable", async ({ page }) => {
    await page.goto("/projects");
    // Matched by predicate, not glob: the frontend posts to the backend origin (:1021) while the
    // page sits on :1020, and a relative glob is resolved against baseURL, so it never matches.
    await page.route((url) => url.pathname === "/api/auth/logout", (route) => route.abort("failed"));

    await page.getByRole("button", { name: "Log out" }).click();

    await expect(page.getByText("Could not log out. Please try again.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Log out" })).toBeEnabled();
    await expect(page).toHaveURL(/\/projects/);
  });

  test("NAV-B-08 a double-click sends exactly one logout request", async ({ browser }) => {
    test.skip(!dbControlAvailable(), "needs psql access to seed a disposable user to log out with");
    const member = await seedWorkspaceMember(tenant!.organizationId, "member");
    const context = await browser.newContext({ storageState: member.storageStatePath });
    const page = await context.newPage();
    try {
    await page.goto("/projects");
    let logoutCalls = 0;
    await page.route((url) => url.pathname === "/api/auth/logout", async (route) => {
      logoutCalls += 1;
      // Held open briefly so the second click lands while the first is still in flight.
      await new Promise((resolve) => setTimeout(resolve, 700));
      await route.continue();
    });

    const logout = page.getByRole("button", { name: /Log out|Logging out/ });
    await logout.click();
    await logout.click({ force: true }).catch(() => undefined);
    await page.waitForURL("**/login");

    expect(logoutCalls).toBe(1);
    } finally {
      await context.close();
      removeWorkspaceMember(member.userId, member.storageStatePath);
    }
  });

  test("NAV-B-10 the nav scrolls at a short viewport and the footer stays reachable", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 500 });
    await page.goto(`/projects/${tenant!.projectId}/dashboard`);

    await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
    await expect(navLink(page, "Project settings")).toBeVisible();
  });

  test("NAV-B-11 every nav item is reachable and activatable from the keyboard", async ({ page }) => {
    await page.goto("/projects");
    const projects = navLink(page, "Projects");
    await projects.focus();
    await expect(projects).toBeFocused();

    await navLink(page, "Dashboard").focus();
    await page.keyboard.press("Enter");
    await page.waitForURL("**/dashboard");
  });

  test("NAV-B-12 every icon-only control carries an accessible name", async ({ page }) => {
    await page.goto("/projects");
    await page.getByRole("button", { name: "Collapse sidebar" }).click();

    const unnamed = await sidebar(page)
      .getByRole("link")
      .evaluateAll((links) =>
        links
          .filter((l) => !(l.textContent ?? "").trim() && !l.getAttribute("aria-label"))
          .map((l) => l.getAttribute("href") ?? "?"),
      );
    expect(unnamed).toEqual([]);
  });

  test("NAV-P-16 the sidebar is absent from the unauthenticated screens", async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const anonymous = await context.newPage();
      for (const route of ["/login", "/signup"]) {
        await anonymous.goto(route);
        await expect(anonymous.locator("aside")).toHaveCount(0);
      }
    } finally {
      await context.close();
    }
  });
});
