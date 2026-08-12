import fs from "node:fs";
import path from "node:path";

function isLocalHost(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:1011";
const webBaseUrl = process.env.WEB_BASE_URL ?? "http://localhost:1010";
const targetIsLocal = isLocalHost(apiBaseUrl);

const ROOT_ENV_PATH = path.resolve(__dirname, "../../.env");
let rootEnvCache: Record<string, string> | null = null;

/**
 * The repo-root `.env` the local docker stack is booted from.
 *
 * Read only so the billing suites can reuse the backend's own Stripe values (webhook signing
 * secret, price IDs) without a human copying them into a second file. Consulted ONLY for a
 * localhost target: against a remote environment these values would be the wrong ones, and
 * signing a webhook with the wrong secret produces a confusing 400 rather than a clean skip.
 */
function rootEnv(): Record<string, string> {
  if (rootEnvCache) return rootEnvCache;
  rootEnvCache = {};
  if (!targetIsLocal) return rootEnvCache;
  try {
    for (const line of fs.readFileSync(ROOT_ENV_PATH, "utf-8").split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      rootEnvCache[match[1]] = value;
    }
  } catch {
    // No root .env (or unreadable) — every consumer treats "" as "not configured" and skips.
  }
  return rootEnvCache;
}

// Prefers an explicit E2E_-prefixed override (the only workable option against a remote target),
// then the value already in this process's environment, then the local stack's own .env.
function backendValue(key: string): string {
  return process.env[`E2E_${key}`] ?? process.env[key] ?? rootEnv()[key] ?? "";
}

/*
 * The domain every address this suite invents lives at. It MUST be a real, mail-accepting one.
 *
 * Signup, OTP and invite all send through EmailService, which posts to Postmark whenever
 * POSTMARK_API_TOKEN is set — and the token in the repo-root .env has repeatedly been a LIVE
 * server token. This suite used to mint addresses at `tesbo.local` / `tesbo-e2e.local`, domains
 * that do not exist, so every one of those sends was a real delivery attempt to nowhere: ~1100
 * bounces accumulated on the live server and got the sending account flagged.
 *
 * mailinator.com is the deliberate choice: it accepts every address without bouncing, and its
 * inboxes are readable over a public API, which is what a spec that has to read a real
 * verification code needs. Keep local-parts to [a-z0-9-] so they're valid inbox names.
 *
 * Note that Mailinator inboxes are PUBLIC. That's fine for throwaway tenants on a local stack;
 * don't point this at a domain whose mail matters, and don't rely on these addresses being
 * private on a deployed target.
 */
export const emailDomain = process.env.E2E_EMAIL_DOMAIN ?? "mailinator.com";

/** `testAddress("invite-badcode")` → `e2e-invite-badcode-<unique>@<emailDomain>`. */
export function testAddress(label: string, unique: string | number = Date.now()): string {
  const slug = `e2e-${label}-${unique}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `${slug}@${emailDomain}`;
}

export const env = {
  apiBaseUrl,
  webBaseUrl,
  ci: !!process.env.CI,

  // Disposable smoke-test account. On a fresh stack this user doesn't exist yet —
  // global-setup creates it automatically when autoProvision is enabled (see below).
  testEmail: process.env.E2E_TEST_EMAIL ?? `e2e-smoke@${emailDomain}`,
  testPassword: process.env.E2E_TEST_PASSWORD ?? "E2eSmokeTest!2026",
  testName: process.env.E2E_TEST_NAME ?? "E2E Smoke User",

  orgName: process.env.E2E_ORG_NAME ?? "E2E Smoke Org",
  projectName: process.env.E2E_PROJECT_NAME ?? "E2E Smoke Project",

  // Second, fully independent tenant — used only by the cross-tenant authorization suite
  // (e2e/api/authorization.spec.ts) to prove account B can't reach account A's resources.
  testEmailB: process.env.E2E_TEST_EMAIL_B ?? `e2e-smoke-b@${emailDomain}`,
  testPasswordB: process.env.E2E_TEST_PASSWORD_B ?? "E2eSmokeTestB!2026",
  testNameB: process.env.E2E_TEST_NAME_B ?? "E2E Smoke User B",
  orgNameB: process.env.E2E_ORG_NAME_B ?? "E2E Smoke Org B",
  projectNameB: process.env.E2E_PROJECT_NAME_B ?? "E2E Smoke Project B",

  /*
   * Two more disposable tenants, existing purely for the payment suites.
   *
   * Those suites drive plan transitions by writing the workspace's billing columns straight into
   * Postgres — there is no other way to reach "grace period expired" or "payment failed" without
   * real money and real waiting. That makes them destructive to whatever workspace they run
   * against, so they never touch the shared smoke workspace (account A), whose plan every other
   * spec implicitly depends on being unrestricted Launch.
   *
   * One tenant per spec FILE, not one for both: playwright.config.ts sets fullyParallel: false,
   * which serialises tests within a file but still runs different files concurrently across
   * workers. Sharing a workspace between the API and UI billing specs would let one file's
   * "downgrade now" land in the middle of the other file's "we're on Pro" assertions.
   */
  billingApiEmail: process.env.E2E_BILLING_API_EMAIL ?? `e2e-billing-api@${emailDomain}`,
  billingApiPassword: process.env.E2E_BILLING_API_PASSWORD ?? "E2eBillingApi!2026",
  billingApiName: process.env.E2E_BILLING_API_NAME ?? "E2E Billing API User",
  billingApiOrgName: process.env.E2E_BILLING_API_ORG_NAME ?? "E2E Billing API Org",
  billingApiProjectName: process.env.E2E_BILLING_API_PROJECT_NAME ?? "E2E Billing API Project",

  billingUiEmail: process.env.E2E_BILLING_UI_EMAIL ?? `e2e-billing-ui@${emailDomain}`,
  billingUiPassword: process.env.E2E_BILLING_UI_PASSWORD ?? "E2eBillingUi!2026",
  billingUiName: process.env.E2E_BILLING_UI_NAME ?? "E2E Billing UI User",
  billingUiOrgName: process.env.E2E_BILLING_UI_ORG_NAME ?? "E2E Billing UI Org",
  billingUiProjectName: process.env.E2E_BILLING_UI_PROJECT_NAME ?? "E2E Billing UI Project",

  /*
   * One more disposable tenant, for the screen-level UI suites (projects list, navigation, theme,
   * project dashboard) and the project-dashboard API suite.
   *
   * These suites need to create and delete SEVERAL projects at once — to assert list ordering, the
   * grid/list parity, per-status cards, and per-project dashboard arithmetic — and they need the
   * project list to hold nothing but their own fixtures so a count or an order is deterministic.
   *
   * Account A can't give them that. It's a Launch workspace, and PROJECT_LIMITS.launch is 2, so with
   * its own smoke project already in place there is exactly ONE spare project slot in the entire
   * workspace. Different spec FILES run concurrently across workers (fullyParallel only serialises
   * within a file), so two files both reaching for that slot would 403 each other at random. Hence a
   * tenant of its own, which global-setup puts on Pro for unlimited projects.
   */
  screensEmail: process.env.E2E_SCREENS_EMAIL ?? `e2e-screens@${emailDomain}`,
  screensPassword: process.env.E2E_SCREENS_PASSWORD ?? "E2eScreens!2026",
  screensName: process.env.E2E_SCREENS_NAME ?? "E2E Screens User",
  screensOrgName: process.env.E2E_SCREENS_ORG_NAME ?? "E2E Screens Org",
  screensProjectName: process.env.E2E_SCREENS_PROJECT_NAME ?? "E2E Screens Base Project",

  /*
   * One more disposable tenant, for the workspace-creation suite.
   *
   * That suite creates additional workspaces, and POST /api/workspaces switches the caller's
   * ACTIVE workspace to the one it just made. Every other spec resolves its data through the
   * caller's active workspace, so running this against account A would silently repoint account A
   * at an empty org — and since fullyParallel is false but different FILES still run concurrently,
   * it could do that in the middle of another file's assertions. Hence a tenant of its own.
   *
   * It also needs a name that is NOT any other tenant's org name: the suite asserts on how many
   * workspaces this account owns, so a shared name would make those counts depend on run order.
   */
  workspacesEmail: process.env.E2E_WORKSPACES_EMAIL ?? `e2e-workspaces@${emailDomain}`,
  workspacesPassword: process.env.E2E_WORKSPACES_PASSWORD ?? "E2eWorkspaces!2026",
  workspacesName: process.env.E2E_WORKSPACES_NAME ?? "E2E Workspaces User",
  workspacesOrgName: process.env.E2E_WORKSPACES_ORG_NAME ?? "E2E Workspaces Org",
  workspacesProjectName: process.env.E2E_WORKSPACES_PROJECT_NAME ?? "E2E Workspaces Project",

  /*
   * Stripe values mirrored from the backend's own configuration.
   *
   * The webhook secret is what lets the payment suites exercise the FULL Stripe webhook
   * lifecycle — upgrade, dunning, cancellation, downgrade — with locally signed synthetic events.
   * That verification is a local HMAC, so those tests reach the real handlers without a single
   * Stripe API call and without any Stripe object existing. Empty means the webhook suite skips.
   */
  stripeWebhookSecret: backendValue("STRIPE_WEBHOOK_SECRET"),
  stripePriceIdProMonthly: backendValue("STRIPE_PRICE_ID_PRO_MONTHLY"),
  stripePriceIdProAnnual: backendValue("STRIPE_PRICE_ID_PRO_ANNUAL"),
  stripePriceIdProMonthlyInr: backendValue("STRIPE_PRICE_ID_PRO_MONTHLY_INR"),
  stripePriceIdProAnnualInr: backendValue("STRIPE_PRICE_ID_PRO_ANNUAL_INR"),
  planGraceDays: Number(backendValue("PLAN_GRACE_DAYS") || 30),

  /*
   * Opt-in for the handful of tests that make Stripe WRITE calls (creating a real Checkout
   * Session, opening a real Billing Portal session). Off by default and deliberately so: a
   * deployment's STRIPE_SECRET_KEY is frequently a live key, and a Checkout Session created
   * against a live account creates a real Customer and permanently pins that workspace's
   * billing currency. Everything else in the payment suites is either read-only against Stripe
   * or driven by locally signed webhooks, so the default run is safe against any environment.
   */
  allowStripeWrites: process.env.E2E_BILLING_ALLOW_STRIPE_WRITES === "true",

  // Signup requires an OTP. When the target looks local, global-setup tries two ways to get
  // one without a human in the loop, in order: (1) sign up over the real API and scrape the
  // OTP out of `docker compose logs` — works when no Postmark token is configured, since the
  // backend then just console.logs the code instead of emailing it; (2) if that doesn't turn
  // up a code within a few seconds (e.g. a real POSTMARK_API_TOKEN is set, so the code went
  // out as an actual email instead), seed the user directly into Postgres with a correctly
  // hashed password, bypassing OTP delivery entirely. Against a remote target, pre-create the
  // user yourself and either leave this unset (it defaults to false there) or set it to false.
  autoProvision: process.env.E2E_AUTO_PROVISION
    ? process.env.E2E_AUTO_PROVISION === "true"
    : targetIsLocal,
  dockerComposeFile:
    process.env.E2E_DOCKER_COMPOSE_FILE ?? path.resolve(__dirname, "../../docker-compose.yml"),
  dockerService: process.env.E2E_DOCKER_SERVICE ?? "backend",
  dbService: process.env.E2E_DB_SERVICE ?? "postgres",
  dbUser: process.env.E2E_DB_USER ?? process.env.POSTGRES_USER ?? "postgres",
  dbName: process.env.E2E_DB_NAME ?? process.env.POSTGRES_DB ?? "tesbo",
};
