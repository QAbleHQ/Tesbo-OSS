import { expect, test, type APIRequestContext } from "@playwright/test";
import { loginAs, provisionRbacTenant, rbacSuiteSkipReason, type RbacTenant } from "../utils/rbac-tenant";
import { purgeProject } from "../utils/seed";

/*
 * Regression coverage for the project key a workspace derives from a project's name.
 *
 * Found while building the Wave 6 reports fixture: projectKey() upper-cases the name, strips every
 * non-alphanumeric character and truncates to 16, and (organization_id, key) is UNIQUE. So any two
 * project names that agree on their first 16 alphanumeric characters produce the same key, and the
 * second create fails on the constraint — as an unhandled 500 with an "Internal server error" body,
 * not as a validation response. "Mobile App Regression — Payments" and "Mobile App Regression —
 * Search" are enough to hit it.
 *
 * This file owns its own tenant because it creates and archives projects, and reports.spec.ts's
 * plan-lock test reads its tenant's project count.
 */

let tenant: RbacTenant | null = null;
let skipReason: string | null = null;
let asOwner: APIRequestContext;

/** 16+ shared alphanumerics, so both names derive the same truncated key. */
const SHARED_PREFIX = "E2E Key Collision Suite";

test.beforeAll(async () => {
  tenant = await provisionRbacTenant("project-keys");
  skipReason = rbacSuiteSkipReason(tenant);
  if (!tenant) return;
  asOwner = await loginAs(tenant.owner);
});

test.afterAll(async () => {
  if (asOwner) await asOwner.dispose();
});

test.beforeEach(() => {
  test.skip(Boolean(skipReason), skipReason ?? "");
});

async function createProject(name: string, extra: Record<string, unknown> = {}) {
  return asOwner.post("/api/projects", { data: { name, ...extra }, failOnStatusCode: false });
}

test.describe("project key derivation", () => {
  test("PKY-A-01 two projects whose names share a long prefix can both be created", { tag: '@tesbo.testId("TES-TC-402")' }, async () => {
    const stamp = Date.now();
    const first = await createProject(`${SHARED_PREFIX} Payments ${stamp}`);
    expect(first.status(), await first.text()).toBe(201);
    const firstBody = await first.json();

    let secondBody: { id: string; key: string } | null = null;
    try {
      const second = await createProject(`${SHARED_PREFIX} Search ${stamp}`);
      // Before the fix this is a 500 from the unique index on (organization_id, key).
      expect(second.status(), await second.text()).toBe(201);
      secondBody = await second.json();

      expect(secondBody!.key).not.toBe(firstBody.key);
      expect(secondBody!.key.length).toBeLessThanOrEqual(32);

      const list = await (await asOwner.get("/api/projects")).json();
      const ids = (Array.isArray(list) ? list : list.projects ?? []).map((p: any) => p.id);
      expect(ids).toContain(firstBody.id);
      expect(ids).toContain(secondBody!.id);
    } finally {
      purgeProject(firstBody.id);
      if (secondBody) purgeProject(secondBody.id);
    }
  });

  test("PKY-A-02 an explicitly requested key that is already taken is refused or made unique, never a 500", { tag: '@tesbo.testId("TES-TC-403")' }, async () => {
    const stamp = Date.now();
    const first = await createProject(`E2E Explicit Key A ${stamp}`, { key: `EXPL${stamp}` });
    expect(first.status(), await first.text()).toBe(201);
    const firstBody = await first.json();

    let secondBody: { id: string; key: string } | null = null;
    try {
      const second = await createProject(`E2E Explicit Key B ${stamp}`, { key: `EXPL${stamp}` });
      // Either answer is defensible — reject the duplicate, or allocate a distinct key. A 500 is not.
      expect(second.status(), await second.text()).toBeLessThan(500);
      if (second.status() === 201) {
        secondBody = await second.json();
        expect(secondBody!.key).not.toBe(firstBody.key);
      }
    } finally {
      purgeProject(firstBody.id);
      if (secondBody) purgeProject(secondBody.id);
    }
  });

  test("PKY-A-03 a name made entirely of punctuation still yields a usable key", { tag: '@tesbo.testId("TES-TC-404")' }, async () => {
    const first = await createProject("E2E ??? !!! ---");
    expect(first.status(), await first.text()).toBe(201);
    const firstBody = await first.json();
    let secondBody: { id: string; key: string } | null = null;
    try {
      // Both names strip down to "E2E", so the second has to be made unique too.
      const second = await createProject("E2E *** ///");
      expect(second.status(), await second.text()).toBe(201);
      secondBody = await second.json();
      expect(secondBody!.key).not.toBe(firstBody.key);
    } finally {
      purgeProject(firstBody.id);
      if (secondBody) purgeProject(secondBody.id);
    }
  });
});
