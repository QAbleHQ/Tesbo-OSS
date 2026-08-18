import fs from "node:fs";
import path from "node:path";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { env } from "../utils/env";
import { column, dbControlAvailable, exec, literal, scalar } from "../utils/psql";

/*
 * Workspace names are not globally unique — regression suite for the duplicate-name signup failure.
 *
 * `organizations.slug` is UNIQUE across the whole install, and both creation paths used to insert a
 * bare slugify(name). So the second account anywhere in the world to pick "Acme" hit a raw Postgres
 * unique violation, which surfaced to that user as a server error on a perfectly valid name. A
 * workspace's identity is its UUID plus its owner row in organization_members, never its name, so
 * these tests pin down the two halves of the fix: the name is free to repeat, and the workspaces
 * that share one stay separate, separately-owned records.
 *
 * This suite runs against its own disposable tenant (see env.workspacesEmail) because
 * POST /api/workspaces switches the caller's ACTIVE workspace to the one it just created — doing
 * that to a shared account would repoint other specs at an empty org mid-run.
 *
 * There is no delete-workspace endpoint, so teardown goes through Postgres directly. Without that
 * access every run would leak workspaces into the target, which is why the suite skips rather than
 * runs uncleaned when docker isn't reachable.
 */

const CONTEXT_PATH = path.join(__dirname, "../.auth/context-workspaces.json");
const STATE_PATH = path.join(__dirname, "../.auth/state-workspaces.json");

type Tenant = { organizationId: string; projectId: string; email: string };

function tenant(): Tenant | null {
  if (!fs.existsSync(CONTEXT_PATH)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(CONTEXT_PATH, "utf-8"));
    if (!parsed?.organizationId || !parsed?.email) return null;
    return parsed;
  } catch {
    return null;
  }
}

const owner = tenant();

/** Workspaces created by this suite, torn down in afterAll. */
const createdOrgIds: string[] = [];

let asOwner: APIRequestContext;

async function createWorkspace(
  api: APIRequestContext,
  name: string,
): Promise<{ status: number; body: any }> {
  const res = await api.post("/api/workspaces", { data: { orgName: name }, failOnStatusCode: false });
  const body = await res.json().catch(() => null);
  if (res.ok() && body?.organizationId) createdOrgIds.push(body.organizationId);
  return { status: res.status(), body };
}

test.describe("workspace creation — duplicate names across and within accounts", () => {
  test.skip(!dbControlAvailable(), "needs `docker compose exec postgres psql` to tear down the workspaces it creates");
  test.skip(!owner, "needs the disposable workspaces tenant provisioned by global-setup");

  test.beforeAll(async () => {
    asOwner = await request.newContext({ baseURL: env.apiBaseUrl, storageState: STATE_PATH });
  });

  test.afterAll(async () => {
    await asOwner?.dispose();
    if (!owner || createdOrgIds.length === 0) return;

    // users.active_organization_id references organizations(id) with no ON DELETE action, so every
    // pointer at a doomed org has to be cleared before the delete or Postgres rejects it. Then the
    // tenant is put back on the workspace global-setup gave it, so a re-run starts where it did.
    const ids = createdOrgIds.map((id) => literal(id)).join(", ");
    exec(
      `UPDATE users SET active_organization_id = NULL WHERE active_organization_id IN (${ids});
       DELETE FROM organizations WHERE id IN (${ids});
       UPDATE users SET active_organization_id = ${literal(owner.organizationId)} WHERE email = ${literal(owner.email)};`,
    );
  });

  test("a second account can create a workspace whose name another account already owns", async () => {
    // The exact reported failure. env.orgName belongs to account A, provisioned by global-setup
    // under a different user — so this is one account claiming a name another account holds.
    const foreignOwners = scalar(
      `SELECT COUNT(*) FROM organizations o
       JOIN organization_members om ON om.organization_id = o.id AND om.role = 'owner'
       JOIN users u ON u.id = om.user_id
       WHERE o.name = ${literal(env.orgName)} AND u.email <> ${literal(owner!.email)};`,
    );
    expect(
      Number(foreignOwners),
      `"${env.orgName}" should already be owned by another account for this test to mean anything`,
    ).toBeGreaterThan(0);

    const { status, body } = await createWorkspace(asOwner, env.orgName);

    expect(status, "creating a workspace under an already-claimed name must not fail").toBe(201);
    expect(body.organizationId).toBeTruthy();
  });

  test("the same account can create two workspaces sharing one name", async () => {
    const name = `E2E Duplicate Name ${Date.now()}`;

    const first = await createWorkspace(asOwner, name);
    const second = await createWorkspace(asOwner, name);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.organizationId).not.toBe(first.body.organizationId);
  });

  test("the workspace keeps the name exactly as typed — only the slug is disambiguated", async () => {
    const name = `E2E Verbatim Name ${Date.now()}`;

    await createWorkspace(asOwner, name);
    const firstSlug = scalar(`SELECT slug FROM organizations WHERE name = ${literal(name)};`);

    const { body } = await createWorkspace(asOwner, name);

    // The user-visible name is untouched: no "(2)", no suffix, no rename.
    const active = await (await asOwner.get("/api/workspace")).json();
    expect(active.id).toBe(body.organizationId);
    expect(active.name).toBe(name);

    // The collision is absorbed by the slug instead, which nothing routes or looks up by.
    expect(active.slug).not.toBe(firstSlug);
    expect(active.slug).toMatch(/-[0-9a-f]{6}$/);
    expect(active.slug.length).toBeLessThanOrEqual(64);
  });

  test("same-named workspaces are distinct records, each owned by its creator", async () => {
    const name = `E2E Ownership ${Date.now()}`;

    const first = await createWorkspace(asOwner, name);
    const second = await createWorkspace(asOwner, name);

    const list = await (await asOwner.get("/api/workspaces")).json();
    const mine = list.filter((w: any) => w.name === name);

    expect(mine).toHaveLength(2);
    expect(new Set(mine.map((w: any) => w.id))).toEqual(
      new Set([first.body.organizationId, second.body.organizationId]),
    );
    expect(new Set(mine.map((w: any) => w.slug)).size, "each workspace needs its own slug").toBe(2);
    for (const workspace of mine) expect(workspace.role).toBe("owner");

    // Ownership is per-workspace: the account that owns the identically-named workspace from the
    // first test is a different user, and its workspace must not appear in this account's list.
    const ownerEmails = column(
      `SELECT DISTINCT u.email FROM organizations o
       JOIN organization_members om ON om.organization_id = o.id AND om.role = 'owner'
       JOIN users u ON u.id = om.user_id
       WHERE o.name = ${literal(env.orgName)};`,
    );
    expect(ownerEmails.length, `"${env.orgName}" should now be owned by two separate accounts`).toBe(2);
    expect(ownerEmails).toContain(owner!.email);

    const listedIds = list.map((w: any) => w.id);
    const otherAccountsOrgs = column(
      `SELECT o.id FROM organizations o
       JOIN organization_members om ON om.organization_id = o.id AND om.role = 'owner'
       JOIN users u ON u.id = om.user_id
       WHERE o.name = ${literal(env.orgName)} AND u.email <> ${literal(owner!.email)};`,
    );
    for (const foreignId of otherAccountsOrgs) expect(listedIds).not.toContain(foreignId);
  });

  test("switching between two same-named workspaces resolves by ID, not by name", async () => {
    const name = `E2E Switch ${Date.now()}`;

    const first = await createWorkspace(asOwner, name);
    const second = await createWorkspace(asOwner, name);
    // Asserted before the switch: without this, a build that rejects the duplicate would still
    // reach the assertions below with one workspace and pass them.
    expect([first.status, second.status]).toEqual([201, 201]);

    // Creation left the second one active; switching back must land on the first, which is only
    // distinguishable from its twin by ID.
    const switched = await asOwner.post(`/api/workspaces/${first.body.organizationId}/switch`);
    expect(switched.ok()).toBeTruthy();

    const active = await (await asOwner.get("/api/workspace")).json();
    expect(active.id).toBe(first.body.organizationId);
    expect(active.id).not.toBe(second.body.organizationId);
    expect(active.name).toBe(name);
  });
});
