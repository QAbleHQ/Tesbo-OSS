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

export const env = {
  apiBaseUrl,
  webBaseUrl,
  ci: !!process.env.CI,

  // Disposable smoke-test account. On a fresh stack this user doesn't exist yet —
  // global-setup creates it automatically when autoProvision is enabled (see below).
  testEmail: process.env.E2E_TEST_EMAIL ?? "e2e-smoke@tesbo.local",
  testPassword: process.env.E2E_TEST_PASSWORD ?? "E2eSmokeTest!2026",
  // Person names must be letters/spaces/hyphens/apostrophes/periods only (see
  // validatePersonName) — the digit in "E2E" makes signup reject the account, which fails
  // global-setup before any spec runs. Only the *person* names are constrained; org and
  // project names below are free-form and keep the E2E prefix.
  testName: process.env.E2E_TEST_NAME ?? "EToE Smoke User",

  orgName: process.env.E2E_ORG_NAME ?? "E2E Smoke Org",
  projectName: process.env.E2E_PROJECT_NAME ?? "E2E Smoke Project",

  // Second, fully independent tenant — used only by the cross-tenant authorization suite
  // (e2e/api/authorization.spec.ts) to prove account B can't reach account A's resources.
  testEmailB: process.env.E2E_TEST_EMAIL_B ?? "e2e-smoke-b@tesbo.local",
  testPasswordB: process.env.E2E_TEST_PASSWORD_B ?? "E2eSmokeTestB!2026",
  testNameB: process.env.E2E_TEST_NAME_B ?? "EToE Smoke User B",
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
  billingApiEmail: process.env.E2E_BILLING_API_EMAIL ?? "e2e-billing-api@tesbo.local",
  billingApiPassword: process.env.E2E_BILLING_API_PASSWORD ?? "E2eBillingApi!2026",
  billingApiName: process.env.E2E_BILLING_API_NAME ?? "EToE Billing API User",
  billingApiOrgName: process.env.E2E_BILLING_API_ORG_NAME ?? "E2E Billing API Org",
  billingApiProjectName: process.env.E2E_BILLING_API_PROJECT_NAME ?? "E2E Billing API Project",

  billingUiEmail: process.env.E2E_BILLING_UI_EMAIL ?? "e2e-billing-ui@tesbo.local",
  billingUiPassword: process.env.E2E_BILLING_UI_PASSWORD ?? "E2eBillingUi!2026",
  billingUiName: process.env.E2E_BILLING_UI_NAME ?? "EToE Billing UI User",
  billingUiOrgName: process.env.E2E_BILLING_UI_ORG_NAME ?? "E2E Billing UI Org",
  billingUiProjectName: process.env.E2E_BILLING_UI_PROJECT_NAME ?? "E2E Billing UI Project",

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
