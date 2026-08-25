import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { env, testAddress } from "../utils/env";
import {
  clearInvitations,
  detachUserByEmail,
  FIXTURE_PASSWORD,
  loginAs,
  mintInviteToken,
  provisionRbacTenant,
  rbacSuiteSkipReason,
  seedFixtureUser,
  type RbacTenant,
} from "../utils/rbac-tenant";

/**
 * /login's handling of `?redirect=`, covering the two defects that parameter carried.
 *
 * The first was reported from a real session (BetterBugs 6a82d9a325941ab3dd0acb72): a user clicked
 * "Sign in" from an already-accepted invite and sat on the "Loading..." screen for the rest of the
 * recording. The cause was not the invite flow at all — /projects on app-stage.tesbo.io answers 307
 * → /login?redirect=%2Fprojects unless a `tesbo_session` cookie is present on the *frontend* host,
 * and it never is: the backend sets that cookie with no Domain attribute, so it belongs to the API
 * host alone. `authMe()` reaches the API cross-origin with credentials and does see the session, so
 * /login kept concluding the user was signed in and sending them back to a destination that kept
 * refusing them.
 *
 * Locally both halves are `localhost`, so the cookie *is* visible to the frontend and no
 * configuration reproduces that rule — which is exactly why it reached a QA session unnoticed. The
 * gate is therefore injected per-test below, which reproduces it deterministically and keeps these
 * tests honest about what they cover: the app's response to a bouncing destination, not the edge
 * rule itself, which lives outside this repo.
 */

/** Any host that is not the stack under test. Used to prove a hostile redirect is never followed. */
const OFF_SITE = /(^|\/\/)([^/]*\.)?example\.com/;

/**
 * Stands in for the stage edge rule: answers `pathname` with 307 → /login?redirect=<pathname>.
 *
 * Returns the request log so a test can assert the loop is *bounded* rather than merely survivable.
 * Before the fix this array grew for as long as the tab stayed open.
 */
async function installBounceGate(page: Page, pathname: string): Promise<string[]> {
  const bounces: string[] = [];
  await page.route(
    (url) => url.pathname === pathname,
    async (route) => {
      bounces.push(route.request().url());
      await route.fulfill({
        status: 307,
        headers: { location: `/login?redirect=${encodeURIComponent(pathname)}` },
      });
    },
  );
  return bounces;
}

/** Records every attempt to leave the stack, and blocks it, so a test can never reach the network. */
async function blockOffSiteNavigation(page: Page): Promise<string[]> {
  const attempts: string[] = [];
  await page.route(OFF_SITE, async (route) => {
    attempts.push(route.request().url());
    await route.abort();
  });
  return attempts;
}

test.describe("login redirect loop", () => {
  // These run with the suite's default authenticated storage state on purpose: the defect only
  // exists for a user the app already considers signed in.

  for (const target of ["/projects", "/settings"]) {
    test(`a destination that bounces back (${target}) cannot pin the user on the loading screen`, async ({
      page,
    }) => {
      const bounces = await installBounceGate(page, target);

      await page.goto(`/login?redirect=${encodeURIComponent(target)}`);

      // The form, and an explanation naming the destination that could not be reached.
      await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
      await expect(page.locator('p[role="alert"]')).toContainText(`could not open ${target}`);
      await expect(page.getByText("Loading...")).toHaveCount(0);
      await expect(page).toHaveURL(/\/login/);

      /*
       * Bounded, which is the assertion that matters: the reported session turned over twice in
       * seventeen seconds and would have kept going. Worth knowing which guard does the work here —
       * the router re-renders this same /login instance rather than remounting it when the RSC
       * request for the destination answers with a redirect back, so the mount-time marker check
       * never gets a second turn and the deadline is what releases the user. A hard navigation (the
       * stage case) remounts and the marker fires first; both paths end at this same message, which
       * is why this asserts the outcome rather than the mechanism.
       */
      expect(bounces.length).toBeGreaterThan(0);
      expect(bounces.length).toBeLessThanOrEqual(3);
    });
  }

  test("a destination that works is still redirected to immediately", async ({ page }) => {
    // The guard above must not fire on the happy path: with no gate installed, /projects loads and
    // the user never sees the login form.
    await page.goto("/login?redirect=%2Fprojects");

    await page.waitForURL(/\/projects/);
    await expect(page.getByRole("button", { name: "Logout" })).toBeVisible();
  });

  test("an auth check that never answers still ends up showing the form", async ({ page }) => {
    /*
     * The loop guard can only fire on a fresh mount. This covers everything else that would leave
     * the promise chain unresolved — here, /api/auth/me simply never answers. The reported symptom
     * was the loading screen being terminal, and it must not be terminal for any reason.
     */
    await page.route("**/api/auth/me", () => {
      /* deliberately never fulfilled */
    });

    await page.goto("/login?redirect=%2Fprojects");

    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('p[role="alert"]')).toContainText("taking longer than expected");
  });

  test("a bounce does not leave the tab permanently unable to redirect", async ({ page }) => {
    // Giving up once must not be sticky: the marker is cleared as soon as it is acted on (and is
    // time-boxed besides), so a destination that recovers is redirected to normally.
    const bounces = await installBounceGate(page, "/projects");
    await page.goto("/login?redirect=%2Fprojects");
    await expect(page.locator('p[role="alert"]')).toBeVisible();
    expect(bounces.length).toBeGreaterThan(0);

    // Destination recovers; the next visit is redirected normally.
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.goto("/login?redirect=%2Fprojects");
    await page.waitForURL(/\/projects/);
  });
});

test.describe("login redirect target validation", () => {
  for (const hostile of ["//example.com", "/\\example.com", "https://example.com", "/login"]) {
    test(`ignores redirect=${JSON.stringify(hostile)} and uses the default destination`, async ({
      page,
    }) => {
      const offSite = await blockOffSiteNavigation(page);

      await page.goto(`/login?redirect=${encodeURIComponent(hostile)}`);

      await page.waitForURL(/\/projects/);
      expect(offSite).toEqual([]);
      // Belt and braces: the address bar is on the stack under test, not merely path-matching.
      expect(new URL(page.url()).origin).toBe(new URL(env.webBaseUrl).origin);
    });
  }
});

test.describe("login redirect after signing in through the form", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("honours a legitimate redirect", async ({ page }) => {
    await page.goto("/login?redirect=%2Fsettings");
    await page.getByLabel("Email", { exact: true }).fill(env.testEmail);
    await page.getByLabel("Password", { exact: true }).fill(env.testPassword);
    await page.getByRole("button", { name: "Sign in" }).click();

    await page.waitForURL(/\/settings/);
  });

  test("drops a hostile redirect and falls back to /projects", async ({ page }) => {
    const offSite = await blockOffSiteNavigation(page);

    await page.goto("/login?redirect=%2F%2Fexample.com");
    await page.getByLabel("Email", { exact: true }).fill(env.testEmail);
    await page.getByLabel("Password", { exact: true }).fill(env.testPassword);
    await page.getByRole("button", { name: "Sign in" }).click();

    await page.waitForURL(/\/projects/);
    expect(offSite).toEqual([]);
  });
});

/*
 * The entry path the BetterBugs session actually took into /login.
 *
 * The describes above cover what /login does once it is there. This one covers how the user got
 * there: they opened an invite link that had already been redeemed, and the invite page offered them
 * a "Sign in" button. That button is the seam — it is the only route into /login that arrives with no
 * session, from a page that is itself a dead end, and the recording ends on "Loading...".
 *
 * Its own disposable tenant ("invite-signin") because it needs a real redeemable invitation:
 * api/invitations.spec.ts clears its tenant's pending invites in beforeEach, so borrowing "invites"
 * would have that file delete this one's token mid-test.
 */
test.describe("login reached from an already-accepted invite", () => {
  let tenant: RbacTenant | null = null;
  let asOwner: APIRequestContext | undefined;
  const inviteeEmails: string[] = [];

  test.beforeAll(async () => {
    tenant = await provisionRbacTenant("invite-signin");
    if (!tenant) return;
    asOwner = await loginAs(tenant.owner);
  });

  test.afterAll(async () => {
    if (tenant) clearInvitations(tenant);
    for (const email of inviteeEmails) detachUserByEmail(email);
    await asOwner?.dispose();
  });

  test.beforeEach(() => {
    const reason = rbacSuiteSkipReason(tenant);
    test.skip(reason !== null, reason ?? "");
  });

  /** An invitation that has already been redeemed, and the raw token that redeemed it. */
  async function spentInvite(label: string): Promise<string> {
    const email = testAddress(`invite-signin-${label}`);
    inviteeEmails.push(email);
    const invitee = seedFixtureUser(email, "EndToEnd Invite Signin");

    const created = await asOwner!.post("/api/workspace/invitations", {
      data: { email, role: "qa_engineer" },
      failOnStatusCode: false,
    });
    expect(created.ok(), `inviting ${email} — ${await created.text()}`).toBeTruthy();
    const token = mintInviteToken((await created.json()).id);

    const asInvitee = await loginAs(invitee);
    try {
      const accepted = await asInvitee.post(`/api/invitations/${token}/accept`, {
        data: {},
        failOnStatusCode: false,
      });
      expect(accepted.ok(), `accepting as ${email} — ${await accepted.text()}`).toBeTruthy();
    } finally {
      await asInvitee.dispose();
    }
    return token;
  }

  test("a spent invite link says so and its Sign in button reaches a usable form", async ({ browser }) => {
    const token = await spentInvite("usable");
    // No session: this is somebody following a link out of their mail client.
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const page = await ctx.newPage();
      await page.goto(`/invite/${token}`);

      await expect(page.getByText("Invitation already accepted")).toBeVisible();
      await expect(page.getByText(/already been accepted/)).toBeVisible();

      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/login/);

      // The whole point of the ticket: a form, not a permanent loading screen.
      await expect(page.getByLabel("Email", { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
      await expect(page.getByText("Loading...")).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });

  test("and the form it reaches actually signs the invitee in", async ({ browser }) => {
    const token = await spentInvite("signsin");
    const email = inviteeEmails[inviteeEmails.length - 1];
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const page = await ctx.newPage();
      await page.goto(`/invite/${token}`);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL(/\/login/);

      await page.getByLabel("Email", { exact: true }).fill(email);
      await page.getByLabel("Password", { exact: true }).fill(FIXTURE_PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();

      // They are already a member, so signing in must land them inside the app rather than back on
      // the invite or the loading screen.
      await page.waitForURL(/\/(projects|dashboard)/, { timeout: 20_000 });
      await expect(page.getByText("Loading...")).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });
});
