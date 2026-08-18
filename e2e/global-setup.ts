import fs from "node:fs";
import path from "node:path";
import { request, type APIRequestContext } from "@playwright/test";
import { waitForOtpInLogs } from "./utils/backend-logs";
import { env } from "./utils/env";
import { hashPasswordForSeed } from "./utils/password";
import { exec } from "./utils/psql";

const AUTH_DIR = path.join(__dirname, ".auth");
const STATE_PATH = path.join(AUTH_DIR, "state.json");
const CONTEXT_PATH = path.join(AUTH_DIR, "context.json");
const STATE_PATH_B = path.join(AUTH_DIR, "state-b.json");
const CONTEXT_PATH_B = path.join(AUTH_DIR, "context-b.json");
const STATE_PATH_BILLING_API = path.join(AUTH_DIR, "state-billing-api.json");
const CONTEXT_PATH_BILLING_API = path.join(AUTH_DIR, "context-billing-api.json");
const STATE_PATH_BILLING_UI = path.join(AUTH_DIR, "state-billing-ui.json");
const CONTEXT_PATH_BILLING_UI = path.join(AUTH_DIR, "context-billing-ui.json");
const STATE_PATH_WORKSPACES = path.join(AUTH_DIR, "state-workspaces.json");
const CONTEXT_PATH_WORKSPACES = path.join(AUTH_DIR, "context-workspaces.json");
const STATE_PATH_SCREENS = path.join(AUTH_DIR, "state-screens.json");
const CONTEXT_PATH_SCREENS = path.join(AUTH_DIR, "context-screens.json");

// One tenant's worth of provisioning inputs — account A and account B (see utils/env.ts) each
// pass their own set through the same provisioning/bootstrap logic below.
type Account = {
  email: string;
  password: string;
  name: string;
  orgName: string;
  projectName: string;
  /**
   * Skip the OTP signup attempt and seed this user straight into Postgres.
   *
   * /api/auth/signup/start is IP rate-limited, and every tenant here looks like the same caller, so
   * each extra signup attempt spends budget the auth suite's own rate-limit tests need. Set for
   * tenants that are pure fixtures and never exercise the signup flow itself.
   */
  seedDirectly?: boolean;
};

const accountA: Account = {
  email: env.testEmail,
  password: env.testPassword,
  name: env.testName,
  orgName: env.orgName,
  projectName: env.projectName,
};

const accountB: Account = {
  email: env.testEmailB,
  password: env.testPasswordB,
  name: env.testNameB,
  orgName: env.orgNameB,
  projectName: env.projectNameB,
};

// Sacrificial tenants for the payment suites, which rewrite their workspace's plan/grace/dunning
// columns directly in Postgres. One per billing spec file — see the comment on env.billingApiEmail
// for why they can't share a workspace with each other or with account A.
const billingApiAccount: Account = {
  email: env.billingApiEmail,
  password: env.billingApiPassword,
  name: env.billingApiName,
  orgName: env.billingApiOrgName,
  projectName: env.billingApiProjectName,
  seedDirectly: true,
};

const billingUiAccount: Account = {
  email: env.billingUiEmail,
  password: env.billingUiPassword,
  name: env.billingUiName,
  orgName: env.billingUiOrgName,
  projectName: env.billingUiProjectName,
  seedDirectly: true,
};

// Owns e2e/api/workspaces.spec.ts, which creates extra workspaces and would otherwise repoint a
// shared account's active workspace mid-run — see env.workspacesEmail.
const workspacesAccount: Account = {
  email: env.workspacesEmail,
  password: env.workspacesPassword,
  name: env.workspacesName,
  orgName: env.workspacesOrgName,
  projectName: env.workspacesProjectName,
  seedDirectly: true,
};

// Owns the screen-level suites (ui/projects-list, ui/navigation, ui/theme, ui/project-dashboard and
// the project-dashboard describe in api/projects.spec.ts). Those need many projects at once and an
// otherwise-empty project list — see env.screensEmail for why account A can't provide either.
const screensAccount: Account = {
  email: env.screensEmail,
  password: env.screensPassword,
  name: env.screensName,
  orgName: env.screensOrgName,
  projectName: env.screensProjectName,
  seedDirectly: true,
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryLogin(api: APIRequestContext, account: Account): Promise<boolean> {
  const res = await api.post("/api/auth/password/login", {
    data: { email: account.email, password: account.password },
    failOnStatusCode: false,
  });
  return res.ok();
}

// Best-effort: returns null instead of throwing so the caller can fall back to a DB seed when the
// OTP went out as a real email instead of landing in the container's stdout. With the backend's
// default EMAIL_DELIVERY_MODE=log that no longer happens — the code is printed whether or not a
// Postmark token is configured — so this path, not the DB seed, is what normally runs.
async function tryScrapeOtpFromDockerLogs(email: string): Promise<string | null> {
  return waitForOtpInLogs(email);
}

async function provisionUserViaOtp(api: APIRequestContext, account: Account): Promise<boolean> {
  const startRes = await api.post("/api/auth/signup/start", {
    data: { name: account.name, email: account.email, password: account.password },
    failOnStatusCode: false,
  });
  if (!startRes.ok()) {
    // Don't throw: no OTP means the caller falls back to seeding this user directly, which is the
    // whole reason that fallback exists. The common cause is the IP rate limiter, which is shared
    // across every tenant provisioned in this run — that's a provisioning detail, not a reason to
    // fail the suite before a single test has run.
    console.warn(
      `[e2e] signup/start failed for ${account.email} (${startRes.status()} ${await startRes.text()}) — ` +
        "falling back to seeding the user directly into Postgres",
    );
    return false;
  }

  const code = await tryScrapeOtpFromDockerLogs(account.email);
  if (!code) return false;

  const verifyRes = await api.post("/api/auth/signup/verify", {
    data: { email: account.email, code },
    failOnStatusCode: false,
  });
  if (!verifyRes.ok()) {
    throw new Error(
      `OTP verification failed for ${account.email}: ${verifyRes.status()} ${await verifyRes.text()}`,
    );
  }
  return true;
}

// Sidesteps OTP delivery entirely by inserting the user straight into Postgres — used when
// the console-log OTP path comes up empty (e.g. a real POSTMARK_API_TOKEN is configured, so
// the code went out as an actual email nobody can read).
function provisionUserViaDatabaseSeed(account: Account): void {
  const passwordHash = hashPasswordForSeed(account.password);
  const escape = (value: string) => value.replace(/'/g, "''");
  const sql =
    `INSERT INTO users (email, name, password_hash) VALUES ('${escape(account.email)}', '${escape(account.name)}', '${passwordHash}') ` +
    "ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash;";

  try {
    // Via the shared helper, so this seed lands in the database the API actually reads. It used to
    // run `psql -U <user> -d <name>` against the compose postgres container, which on this stack is
    // an orphan holding its own copy of the schema: the INSERT succeeded, the account was created
    // somewhere the backend never looks, and the caller's follow-up login failed with credentials it
    // had just written. That produced "Provisioned <email> but the follow-up password login still
    // failed" for every tenant seeded this way. See the database rule in the repo's CLAUDE.md.
    exec(sql);
  } catch (error) {
    throw new Error(
      `Could not seed ${account.email} into the database the stack under test uses. This fallback ` +
        "runs psql inside the compose stack, so it needs docker reachable from where these tests run " +
        "and DATABASE_URL set to the backend's own database. If you're targeting a remote " +
        "environment, pre-create the user there and set E2E_TEST_EMAIL / E2E_TEST_PASSWORD (or the " +
        `_B variants), or set E2E_AUTO_PROVISION=false. Underlying error: ${String(error)}`,
    );
  }
}

async function provisionUser(api: APIRequestContext, account: Account): Promise<void> {
  const provisionedViaOtp = account.seedDirectly ? false : await provisionUserViaOtp(api, account);
  if (!provisionedViaOtp) {
    provisionUserViaDatabaseSeed(account);
  }

  const loggedIn = await tryLogin(api, account);
  if (!loggedIn) {
    throw new Error(`Provisioned ${account.email} but the follow-up password login still failed.`);
  }
}

function extractList(body: unknown): any[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const candidate = (body as Record<string, unknown>).projects ?? (body as Record<string, unknown>).data;
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

async function ensureWorkspaceAndProject(
  api: APIRequestContext,
  account: Account,
): Promise<{ organizationId: string; projectId: string }> {
  const workspaceRes = await api.get("/api/workspace", { failOnStatusCode: false });

  if (workspaceRes.status() === 404) {
    const res = await api.post("/api/onboarding/org-and-project", {
      data: { orgName: account.orgName, projectName: account.projectName },
    });
    if (!res.ok()) {
      throw new Error(`Failed to bootstrap org+project: ${res.status()} ${await res.text()}`);
    }
    const body = await res.json();
    return { organizationId: body.organizationId, projectId: body.projectId };
  }

  if (!workspaceRes.ok()) {
    throw new Error(`Failed to fetch workspace: ${workspaceRes.status()} ${await workspaceRes.text()}`);
  }
  const workspace = await workspaceRes.json();

  const projectsRes = await api.get("/api/projects");
  const projects = extractList(await projectsRes.json());
  const existing = projects.find((p) => p.name === account.projectName);
  if (existing) return { organizationId: workspace.id, projectId: existing.id };

  const createRes = await api.post("/api/projects", { data: { name: account.projectName } });
  if (!createRes.ok()) {
    throw new Error(`Failed to create project: ${createRes.status()} ${await createRes.text()}`);
  }
  const created = await createRes.json();
  return { organizationId: workspace.id, projectId: created.id };
}

async function provisionAndResolveContext(
  api: APIRequestContext,
  account: Account,
): Promise<{ organizationId: string; projectId: string }> {
  const loggedIn = await tryLogin(api, account);
  if (!loggedIn) {
    if (!env.autoProvision) {
      throw new Error(
        `No usable session for ${account.email} at ${env.apiBaseUrl} and auto-provisioning is ` +
          "disabled. Either pre-create this user (matching its configured email/password env vars) on " +
          "the target environment, or set E2E_AUTO_PROVISION=true if you have docker log access to it.",
      );
    }
    await provisionUser(api, account);
  }

  return ensureWorkspaceAndProject(api, account);
}

async function setUpAccount(
  account: Account,
  statePath: string,
  contextPath: string,
): Promise<void> {
  const api = await request.newContext({ baseURL: env.apiBaseUrl });

  try {
    // Retry the whole login/provision/workspace sequence a few times — this runs right
    // after a fresh deploy, and a service that only just reported healthy can still be
    // momentarily flaky on its first few real requests.
    let lastError: unknown;
    let result: { organizationId: string; projectId: string } | null = null;
    for (let attempt = 1; attempt <= 3 && !result; attempt++) {
      try {
        result = await provisionAndResolveContext(api, account);
      } catch (error) {
        lastError = error;
        if (attempt < 3) await sleep(2_000);
      }
    }
    if (!result) throw lastError;

    await api.storageState({ path: statePath });
    fs.writeFileSync(
      contextPath,
      JSON.stringify({ organizationId: result.organizationId, projectId: result.projectId, email: account.email }, null, 2),
    );
  } finally {
    await api.dispose();
  }
}

/**
 * Provisions a tenant whose absence must not fail the whole run.
 *
 * The payment and workspace suites each need a workspace they're allowed to break, and they detect
 * a missing context file and skip themselves. So against a target where these tenants can't be
 * created (a remote environment with E2E_AUTO_PROVISION=false, say) the right outcome is "those
 * suites skipped", not "every spec in the run fails during global setup". Any stale context file is
 * removed so a previous run's tenant can't be mistaken for this one's.
 */
async function setUpOptionalAccount(
  account: Account,
  statePath: string,
  contextPath: string,
  label: string,
): Promise<void> {
  try {
    await setUpAccount(account, statePath, contextPath);
  } catch (error) {
    fs.rmSync(contextPath, { force: true });
    console.warn(
      `[e2e] could not provision the ${label} tenant (${account.email}) — the payment suites that ` +
        `depend on it will skip. Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Provisions the screens tenant and puts it on Pro.
 *
 * The Pro write is the point of this wrapper. PROJECT_LIMITS.launch is 2 (plan-limits.service.ts),
 * and every screen suite that owns this tenant needs more projects than that live at once. Pro's
 * project limit is null — unlimited — so the ceiling stops being something those suites have to
 * choreograph around. Nothing else about the plan is exercised here; plan gating itself is the
 * payment suites' job, against their own tenants.
 *
 * Failure removes the context file so the screen suites skip rather than fail: without the Pro
 * write they'd hit a 403 partway through and report a plan limit as if it were a product bug.
 */
async function setUpScreensTenant(): Promise<void> {
  try {
    await setUpAccount(screensAccount, STATE_PATH_SCREENS, CONTEXT_PATH_SCREENS);
    const { organizationId } = JSON.parse(fs.readFileSync(CONTEXT_PATH_SCREENS, "utf-8"));
    setScreensTenantPlanToPro(organizationId);
  } catch (error) {
    fs.rmSync(CONTEXT_PATH_SCREENS, { force: true });
    console.warn(
      `[e2e] could not provision the screens tenant (${screensAccount.email}) — the projects-list, ` +
        "navigation, theme and project-dashboard suites will skip. Underlying error: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

function setScreensTenantPlanToPro(organizationId: string): void {
  // Same reason as provisionUserViaDatabaseSeed: this has to reach the backend's own database, or it
  // upgrades a row the API will never read and the screens suites run against a Launch-plan tenant.
  exec(
    `UPDATE organizations SET plan = 'pro', subscription_status = 'active', updated_at = now() WHERE id = '${organizationId.replace(/'/g, "''")}';`,
  );
}

export default async function globalSetup(): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  // Independent tenants, provisioned with separate APIRequestContexts so their session cookies
  // never mix. Account B only backs the cross-tenant authorization suite, the two billing tenants
  // only back the payment suites, the workspaces tenant only backs the workspace-creation suite,
  // and the screens tenant only backs the screen-level suites — every other spec keeps using
  // account A via the default storageState in playwright.config.ts.
  await setUpAccount(accountA, STATE_PATH, CONTEXT_PATH);
  await setUpAccount(accountB, STATE_PATH_B, CONTEXT_PATH_B);
  await setUpOptionalAccount(billingApiAccount, STATE_PATH_BILLING_API, CONTEXT_PATH_BILLING_API, "billing API");
  await setUpOptionalAccount(billingUiAccount, STATE_PATH_BILLING_UI, CONTEXT_PATH_BILLING_UI, "billing UI");
  await setUpOptionalAccount(workspacesAccount, STATE_PATH_WORKSPACES, CONTEXT_PATH_WORKSPACES, "workspaces");
  await setUpScreensTenant();
}
