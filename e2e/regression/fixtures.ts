import fs from "node:fs";
import path from "node:path";
import { request as pwRequest, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { env } from "../utils/env";

/*
 * Shared helpers for the reported-ticket regression suite.
 *
 * These specs exist to prove that a defect someone filed on the Basecamp board stays fixed. That
 * gives them one requirement the rest of the suite does not have: they must run against ANY
 * deployment — a developer's compose stack, staging, or whatever a CI job is pointed at — with
 * nothing changed but API_BASE_URL / WEB_BASE_URL and the account credentials.
 *
 * So everything here goes over HTTP. Nothing in this folder imports utils/psql, utils/rbac-tenant or
 * any other database-backed helper, because a fixture that needs SQL is a fixture that skips itself
 * on an environment where the database isn't handed out. Where a ticket genuinely cannot be
 * expressed without arranging state directly, the spec says so in a comment rather than quietly
 * reaching for the database.
 *
 * Fixtures live in account A's existing project, the one global-setup resolves into
 * .auth/context.json. That is deliberate: creating a project per run would collide with the Launch
 * plan's 2-project ceiling on a workspace that already owns one. The cost is that this project is
 * shared with the rest of the suite, so nothing here may assert on a project-wide absolute count —
 * only on the fixtures the test itself created.
 */

const AUTH_DIR = path.resolve(__dirname, "../.auth");

export type TenantContext = {
  organizationId: string;
  projectId: string;
  email: string;
};

/**
 * Account A's workspace and project, as global-setup resolved them.
 *
 * Read on demand rather than at module load: a spec file that only drives the UI still imports this
 * module, and failing at import time would turn "the context file is missing" into a collection
 * error with no indication of which run produced it.
 */
export function accountA(): TenantContext {
  const file = path.join(AUTH_DIR, "context.json");
  if (!fs.existsSync(file)) {
    throw new Error(
      `No ${file}. global-setup.ts writes it after logging in as account A — if it is absent the ` +
        "run's global setup did not complete, so check its output rather than this spec.",
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

/**
 * An API context aimed at the backend, carrying account A's session.
 *
 * UI specs need this because the `request` fixture inherits the project's baseURL — the WEB origin
 * for the `ui` project — so a bare `request.get("/api/…")` would ask the frontend for an API route
 * and get a 404 that looks like a product bug. The rest of the suite spells this out at each call
 * site (see ui/executions.spec.ts); one helper keeps this folder's specs shorter and the base URL in
 * a single place. Callers must dispose it.
 */
export async function apiContext(): Promise<APIRequestContext> {
  return pwRequest.newContext({
    baseURL: env.apiBaseUrl,
    storageState: path.join(AUTH_DIR, "state.json"),
  });
}

/*
 * A name no other run, worker or spec will have produced.
 *
 * Date.now() alone is not enough here. Different spec FILES run concurrently across workers
 * (fullyParallel is false, which only serialises within a file), so two files entering the same
 * millisecond is a real collision, and these fixtures share one project. The random suffix removes
 * that. The "E2E REG" prefix makes anything this suite leaves behind identifiable by eye.
 */
export function unique(label: string): string {
  const suffix = Math.random().toString(36).slice(2, 7);
  return `E2E REG ${label} ${Date.now()}-${suffix}`;
}

/**
 * Builds a test title that carries its Basecamp card id.
 *
 * `grep -rn <card-id> e2e/` is how the board's Writing Tests column gets reconciled against the
 * suite — docs/e2e-coverage-waves.md §6c records that a whole bucket got written twice because ten
 * cards were already covered by specs that cited no id. Every test in this folder cites one.
 */
export function ticket(id: string, card: string, description: string): string {
  return `${id} [bc:${card}] ${description}`;
}

// ─── UI locator helpers ─────────────────────────────────────────────────────

/**
 * Every `role="alert"` on the page EXCEPT Next.js's route announcer.
 *
 * `getByRole("alert")` is unusable as-is in this app: the App Router mounts
 * `<div role="alert" aria-live="assertive" id="__next-route-announcer__">` into every page, so a bare
 * alert query always matches at least two elements and dies on Playwright's strict-mode check —
 * which is a test failure that looks nothing like the thing being tested. Filtering it out here
 * keeps that detail in one place instead of in every assertion.
 */
export function alerts(page: Page): Locator {
  return page.locator('[role="alert"]:not(#__next-route-announcer__)');
}

/**
 * The panel of an open `Modal`, found by its title.
 *
 * components/ui/Modal.tsx renders `role="presentation"` on both its backdrop and its panel, and
 * `role="dialog"` on neither — so `getByRole("dialog")` finds nothing at all. The suite already knows
 * this (the existing specs carry comments about modals without `role="dialog"`); this helper stops
 * each new spec from rediscovering it.
 *
 * `.last()` picks the panel rather than the backdrop: both carry the role and both contain the title,
 * and the panel is the inner of the two, so it comes last in document order.
 */
export function modalByTitle(page: Page, title: string): Locator {
  return page
    .locator('div[role="presentation"]')
    .filter({ has: page.getByRole("heading", { name: title }) })
    .last();
}

// ─── API fixture factories ──────────────────────────────────────────────────
//
// Each returns the created entity and leaves deletion to the caller's `finally`, matching the
// convention the rest of the suite already uses. Teardown always passes failOnStatusCode: false so
// a cleanup running after a failed assertion cannot mask the real failure with its own.

export async function createSuite(
  api: APIRequestContext,
  projectId: string,
  name = unique("Suite"),
  extra: Record<string, unknown> = {},
): Promise<{ id: string; name: string; [key: string]: unknown }> {
  const res = await api.post(`/api/projects/${projectId}/suites`, { data: { name, ...extra } });
  if (!res.ok()) throw new Error(`createSuite failed: ${res.status()} ${await res.text()}`);
  return res.json();
}

export async function createTestCase(
  api: APIRequestContext,
  projectId: string,
  fields: Record<string, unknown> = {},
): Promise<{ id: string; title: string; [key: string]: unknown }> {
  const res = await api.post(`/api/projects/${projectId}/testcases`, {
    data: { title: unique("Case"), ...fields },
  });
  if (!res.ok()) throw new Error(`createTestCase failed: ${res.status()} ${await res.text()}`);
  return res.json();
}

export async function createCycle(
  api: APIRequestContext,
  projectId: string,
  fields: Record<string, unknown> = {},
): Promise<{ id: string; name: string; [key: string]: unknown }> {
  const res = await api.post(`/api/projects/${projectId}/cycles`, {
    data: { name: unique("Run"), ...fields },
  });
  if (!res.ok()) throw new Error(`createCycle failed: ${res.status()} ${await res.text()}`);
  return res.json();
}

export async function createPlan(
  api: APIRequestContext,
  projectId: string,
  fields: Record<string, unknown> = {},
): Promise<{ id: string; name: string; [key: string]: unknown }> {
  const res = await api.post(`/api/projects/${projectId}/plans`, {
    data: { name: unique("Plan"), ...fields },
  });
  if (!res.ok()) throw new Error(`createPlan failed: ${res.status()} ${await res.text()}`);
  return res.json();
}

/** Best-effort teardown for a list of [path] entries, in the order given. */
export async function cleanup(api: APIRequestContext, paths: string[]): Promise<void> {
  for (const p of paths) {
    await api.delete(p, { failOnStatusCode: false });
  }
}
