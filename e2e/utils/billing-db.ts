import fs from "node:fs";
import path from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { env } from "./env";
import { column, dbControlAvailable, exec, literal, scalar } from "./psql";

/*
 * Direct Postgres control over a workspace's billing state, for the payment suites.
 *
 * Why this exists at all: every interesting payment state is either behind real money or behind
 * real waiting. "Grace period expired" is 30 days away. "Payment failed" needs a declined card on
 * a live subscription. "Currency locked" needs a settled invoice. None of that is reachable from
 * the API, and mocking Stripe would only test the mock — so these suites put the workspace into
 * the state under test by writing the columns the enforcement logic actually reads, then exercise
 * the real endpoints and the real guards against it.
 *
 * That makes this module destructive by design. It must only ever be pointed at the disposable
 * billing tenants provisioned by global-setup.ts, never at the shared smoke workspace.
 *
 * The Postgres transport itself lives in utils/psql.ts, shared with the other suites that need it.
 */

const AUTH_DIR = path.join(__dirname, "../.auth");

/** Which billing tenant a spec file owns. One file per tenant — see env.billingApiEmail. */
export type BillingTenantKind = "api" | "ui";

export interface BillingTenant {
  organizationId: string;
  projectId: string;
  email: string;
  /** Session state for this tenant, loadable by an APIRequestContext or a browser context. */
  storageStatePath: string;
}

/** The billing columns these suites drive. Mirrors migrations V70 + V74 on `organizations`. */
export interface BillingState {
  plan: "launch" | "pro";
  billing_interval: "monthly" | "annual" | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  billing_currency: "usd" | "inr" | null;
  plan_grace_ends_at: string | null;
  payment_failed_at: string | null;
  grace_locked_notified_at: string | null;
  storage_warned_pct: number | null;
}

const BILLING_COLUMNS: (keyof BillingState)[] = [
  "plan",
  "billing_interval",
  "stripe_customer_id",
  "stripe_subscription_id",
  "subscription_status",
  "current_period_end",
  "cancel_at_period_end",
  "billing_currency",
  "plan_grace_ends_at",
  "payment_failed_at",
  "grace_locked_notified_at",
  "storage_warned_pct",
];

const TENANT_CONTEXT_FILES: Record<BillingTenantKind, { context: string; state: string }> = {
  api: { context: "context-billing-api.json", state: "state-billing-api.json" },
  ui: { context: "context-billing-ui.json", state: "state-billing-ui.json" },
};

/**
 * The disposable workspace this spec file is allowed to break, or null when global-setup couldn't
 * provision it (see setUpOptionalAccount) — in which case the caller skips itself.
 */
export function billingTenant(kind: BillingTenantKind): BillingTenant | null {
  const files = TENANT_CONTEXT_FILES[kind];
  const contextPath = path.join(AUTH_DIR, files.context);
  if (!fs.existsSync(contextPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(contextPath, "utf-8"));
    if (!parsed?.organizationId || !parsed?.projectId) return null;
    return {
      organizationId: parsed.organizationId,
      projectId: parsed.projectId,
      email: parsed.email,
      storageStatePath: path.join(AUTH_DIR, files.state),
    };
  } catch {
    return null;
  }
}

/**
 * Whether the target deployment serves the billing module at all.
 *
 * An HTTP probe rather than a DB one, but it lives with the other payment-suite gates so all three
 * suites share one answer and one message. Worth having because "every payment test 404'd" almost
 * always means API_BASE_URL points at a backend without billing routes — the open-source build ships
 * without them, and the two local stacks listen on different ports — rather than a real regression.
 */
export async function billingModuleUnavailableReason(api: APIRequestContext): Promise<string | null> {
  const res = await api.get("/api/billing/pricing", { failOnStatusCode: false });
  if (res.status() !== 404) return null;
  return (
    `no billing module at ${env.apiBaseUrl} (/api/billing/pricing returned 404) — point API_BASE_URL ` +
    "at a deployment built from this repo, whose local stack publishes the backend on :1021"
  );
}

/** One reason string covering both prerequisites, used verbatim in every skip. */
export function billingSuitePrerequisites(tenant: BillingTenant | null): string | null {
  if (!dbControlAvailable()) {
    return "needs `docker compose exec postgres psql` access to put the workspace into each billing state";
  }
  if (!tenant) return "needs the disposable billing tenant provisioned by global-setup";
  return null;
}

export function readBillingState(organizationId: string): BillingState {
  const json = scalar(
    `SELECT row_to_json(t) FROM (SELECT ${BILLING_COLUMNS.join(", ")} ` +
      `FROM organizations WHERE id = ${literal(organizationId)}) t;`,
  );
  if (!json) throw new Error(`No organization ${organizationId} — is the billing tenant provisioned?`);
  return JSON.parse(json) as BillingState;
}

/**
 * Writes billing columns. Timestamps may be passed as ISO strings — Postgres coerces them in
 * assignment context, so callers don't have to spell out a cast.
 */
export function setBillingState(organizationId: string, patch: Partial<BillingState>): void {
  const assignments = Object.entries(patch).map(
    ([column, value]) => `${column} = ${literal(value as string | number | boolean | null)}`,
  );
  if (assignments.length === 0) return;
  exec(
    `UPDATE organizations SET ${assignments.join(", ")}, updated_at = now() ` +
      `WHERE id = ${literal(organizationId)};`,
  );
}

/**
 * The state a brand-new workspace has: free plan, nothing owed, no Stripe history, no warnings
 * already sent. Every test arranges from here so it can't inherit the previous one's leftovers.
 */
export const PRISTINE_LAUNCH: BillingState = {
  plan: "launch",
  billing_interval: null,
  stripe_customer_id: null,
  stripe_subscription_id: null,
  subscription_status: null,
  current_period_end: null,
  cancel_at_period_end: false,
  billing_currency: null,
  plan_grace_ends_at: null,
  payment_failed_at: null,
  grace_locked_notified_at: null,
  storage_warned_pct: null,
};

export function resetToLaunch(organizationId: string, overrides: Partial<BillingState> = {}): void {
  setBillingState(organizationId, { ...PRISTINE_LAUNCH, ...overrides });
}

/** An active Pro subscription renewing `renewsInDays` from now. */
export function setProPlan(
  organizationId: string,
  overrides: Partial<BillingState> = {},
): void {
  setBillingState(organizationId, {
    ...PRISTINE_LAUNCH,
    plan: "pro",
    billing_interval: "annual",
    subscription_status: "active",
    current_period_end: isoDaysFromNow(300),
    ...overrides,
  });
}

/**
 * A workspace that has lost Pro and is inside its grace window: billed as Launch, still holding
 * Pro-sized limits until the deadline. Positive `daysRemaining` = window open, negative = closed.
 */
export function setGraceWindow(
  organizationId: string,
  daysRemaining: number,
  overrides: Partial<BillingState> = {},
): void {
  setBillingState(organizationId, {
    ...PRISTINE_LAUNCH,
    plan: "launch",
    billing_interval: "annual",
    subscription_status: "canceled",
    plan_grace_ends_at: isoDaysFromNow(daysRemaining),
    ...overrides,
  });
}

export function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * How many times an action has been recorded against this workspace's billing timeline.
 *
 * audit_logs is append-only (a trigger rejects UPDATE/DELETE — migration V62), so "fired exactly
 * once" is asserted as a count DELTA around the action under test rather than by clearing rows.
 */
export function countBillingAuditEntries(organizationId: string, action: string): number {
  return Number(
    scalar(
      `SELECT COUNT(*) FROM audit_logs WHERE organization_id = ${literal(organizationId)} ` +
        `AND entity_type = 'billing' AND action = ${literal(action)};`,
    ),
  );
}

/** Appends a billing timeline entry, for tests that need history to render without a webhook. */
export function insertBillingAuditEntry(
  organizationId: string,
  action: string,
  summary: string,
): void {
  exec(
    `INSERT INTO audit_logs (organization_id, actor_id, action, entity_type, entity_id, entity_name, diff) ` +
      `VALUES (${literal(organizationId)}, NULL, ${literal(action)}, 'billing', NULL, ${literal(summary)}, '{}'::jsonb);`,
  );
}

/**
 * Active project IDs oldest-first — the exact order PlanLimitsService.assertProjectWritable ranks
 * by, so a test can name which projects it expects to stay writable and which to be locked.
 */
export function activeProjectIdsOldestFirst(organizationId: string): string[] {
  return column(
    `SELECT id FROM projects WHERE organization_id = ${literal(organizationId)} ` +
      `AND archived_at IS NULL ORDER BY created_at, id;`,
  );
}

/** Whether an event id was recorded as processed — the webhook replay guard's own bookkeeping. */
export function webhookEventRecorded(eventId: string): boolean {
  return scalar(`SELECT COUNT(*) FROM stripe_webhook_events WHERE id = ${literal(eventId)};`) === "1";
}
