import { execSync } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { request, type APIRequestContext } from "@playwright/test";
import { env } from "./utils/env";

const AUTH_DIR = path.join(__dirname, ".auth");
const STATE_PATH = path.join(AUTH_DIR, "state.json");
const CONTEXT_PATH = path.join(AUTH_DIR, "context.json");
const STATE_PATH_B = path.join(AUTH_DIR, "state-b.json");
const CONTEXT_PATH_B = path.join(AUTH_DIR, "context-b.json");

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Best-effort: returns null instead of throwing so the caller can fall back to a DB seed
// when the OTP went out as a real email instead of landing in the container's stdout.
async function tryScrapeOtpFromDockerLogs(email: string): Promise<string | null> {
  const pattern = new RegExp(`OTP for ${escapeRegExp(email)}: (\\d{6})`);
  const deadline = Date.now() + 8_000;

  while (Date.now() < deadline) {
    try {
      const logs = execSync(
        `docker compose -f "${env.dockerComposeFile}" logs ${env.dockerService} --no-color --tail=500`,
        { encoding: "utf-8" },
      );
      const match = logs.match(pattern);
      if (match) return match[1];
    } catch {
      return null; // docker compose / the CLI itself isn't available here — don't keep retrying
    }
    await sleep(750);
  }
  return null;
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

// Matches Tesbo-Backend-Nest/src/auth/password.service.ts's PasswordService.hashPassword
// exactly (pbkdf2_sha256, 210000 iterations, 32-byte key) — if that format ever changes,
// this needs to change with it.
function hashPasswordForSeed(password: string): string {
  const iterations = 210_000;
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  return `pbkdf2_sha256$${iterations}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
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
    execSync(
      `docker compose -f "${env.dockerComposeFile}" exec -T ${env.dbService} psql -U ${env.dbUser} -d ${env.dbName} -v ON_ERROR_STOP=1`,
      { input: sql, encoding: "utf-8" },
    );
  } catch (error) {
    throw new Error(
      `Could not seed ${account.email} directly into Postgres via docker (service "${env.dbService}"). ` +
        "This local-only fallback requires docker + the compose stack to be reachable from where these " +
        "tests run. If you're targeting a remote environment, pre-create the user there and set " +
        `E2E_TEST_EMAIL / E2E_TEST_PASSWORD (or the _B variants), or set E2E_AUTO_PROVISION=false. Underlying error: ${String(error)}`,
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

export default async function globalSetup(): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  // Independent tenants, provisioned with separate APIRequestContexts so their session cookies
  // never mix. Account B only backs the cross-tenant authorization suite — every other spec keeps
  // using account A via the default storageState in playwright.config.ts.
  await setUpAccount(accountA, STATE_PATH, CONTEXT_PATH);
  await setUpAccount(accountB, STATE_PATH_B, CONTEXT_PATH_B);
}
