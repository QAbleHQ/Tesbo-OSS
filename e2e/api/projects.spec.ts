import { expect, test } from "@playwright/test";

test.describe("project CRUD", () => {
  test("creates a project from just a name and derives a key from it", async ({ request }) => {
    // projectKey() uppercases, strips non-alphanumerics, then keeps only the first 16 chars —
    // so the name must stay short enough that the full (fast-changing) timestamp survives
    // that truncation. A longer prefix like "E2E Project" would eat the budget and leave only
    // the timestamp's slow-changing leading digits, colliding across reruns within the same
    // ~2.8-hour window (organization_id, key) is uniquely constrained forever, even for
    // archived projects.
    const name = `E2E ${Date.now()}`;
    const createRes = await request.post("/api/projects", { data: { name } });
    expect(createRes.ok()).toBeTruthy();
    const created = await createRes.json();
    expect(created.id).toBeTruthy();
    expect(created.name).toBe(name);
    expect(created.key).toMatch(/^[A-Z0-9]{1,16}$/);
    expect(created.projectType).toBe("tesbox");

    await request.delete(`/api/projects/${created.id}`);
  });

  test("creates a project with an explicit key, description and projectType", async ({ request }) => {
    const suffix = Date.now().toString().slice(-8);
    const name = `E2E Full Project ${suffix}`;
    const createRes = await request.post("/api/projects", {
      data: { name, key: `e2e${suffix}`, description: "Created by the e2e suite", projectType: "manual" },
    });
    expect(createRes.ok()).toBeTruthy();
    const created = await createRes.json();
    // projectKey() uppercases and strips non-alphanumerics before storing.
    expect(created.key).toBe(`E2E${suffix}`);
    expect(created.projectType).toBe("manual");

    const getRes = await request.get(`/api/projects/${created.id}`);
    expect((await getRes.json()).description).toBe("Created by the e2e suite");

    await request.delete(`/api/projects/${created.id}`);
  });

  test("rejects creating a project without a name", async ({ request }) => {
    const res = await request.post("/api/projects", { data: {}, failOnStatusCode: false });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/name/i);
  });

  test("rejects creating a project whose key collides with an existing one", async ({ request }) => {
    const suffix = Date.now().toString().slice(-8);
    const key = `DUPE${suffix}`;

    const firstRes = await request.post("/api/projects", { data: { name: `Dup A ${suffix}`, key } });
    expect(firstRes.ok()).toBeTruthy();
    const first = await firstRes.json();

    // Known rough edge, pinned deliberately: (organization_id, key) is unique at the DB level
    // but createProject() doesn't catch that constraint violation, so a collision falls through
    // to the generic unhandled-exception handler as a 500 rather than a clean 4xx. If that's
    // ever fixed, this assertion should be tightened to the new status rather than loosened.
    const secondRes = await request.post("/api/projects", {
      data: { name: `Dup B ${suffix}`, key },
      failOnStatusCode: false,
    });
    expect(secondRes.ok()).toBeFalsy();

    await request.delete(`/api/projects/${first.id}`);
  });

  test("supports the read -> update -> delete lifecycle", async ({ request }) => {
    const suffix = Date.now().toString().slice(-8);
    const name = `E2E Lifecycle Project ${suffix}`;
    // Explicit key: the name alone is too long for projectKey()'s 16-char budget to retain any
    // of the timestamp (see the "derives a key from it" test above for why that matters).
    const createRes = await request.post("/api/projects", { data: { name, key: `E2ELIFE${suffix}` } });
    const created = await createRes.json();

    const getRes = await request.get(`/api/projects/${created.id}`);
    expect(getRes.ok()).toBeTruthy();
    expect((await getRes.json()).name).toBe(name);

    const updatedName = `${name} (renamed)`;
    const patchRes = await request.patch(`/api/projects/${created.id}`, {
      data: { name: updatedName, description: "updated description", settings: { foo: "bar" } },
    });
    expect(patchRes.ok()).toBeTruthy();

    const getAfterUpdateRes = await request.get(`/api/projects/${created.id}`);
    const afterUpdate = await getAfterUpdateRes.json();
    expect(afterUpdate.name).toBe(updatedName);
    expect(afterUpdate.description).toBe("updated description");
    expect(afterUpdate.settings).toMatchObject({ foo: "bar" });

    const listRes = await request.get("/api/projects");
    const list = await listRes.json();
    expect(list.some((p: { id: string }) => p.id === created.id)).toBeTruthy();

    const deleteRes = await request.delete(`/api/projects/${created.id}`);
    expect(deleteRes.ok()).toBeTruthy();

    const getAfterDeleteRes = await request.get(`/api/projects/${created.id}`, {
      failOnStatusCode: false,
    });
    expect(getAfterDeleteRes.status()).toBe(404);

    const listAfterDeleteRes = await request.get("/api/projects");
    const listAfterDelete = await listAfterDeleteRes.json();
    expect(listAfterDelete.some((p: { id: string }) => p.id === created.id)).toBeFalsy();
  });

  test("updating a project with an empty name blanks it out (no server-side validation on update)", async ({
    request,
  }) => {
    // Unlike create, updateProject() has no "name required" check — COALESCE only skips
    // null/undefined, and "" is neither, so PATCH {name: ""} really does blank the name.
    // This documents that gap rather than papering over it.
    const suffix = Date.now().toString().slice(-8);
    const name = `E2E Blankable Project ${suffix}`;
    const createRes = await request.post("/api/projects", { data: { name, key: `E2EBLANK${suffix}` } });
    const created = await createRes.json();

    const patchRes = await request.patch(`/api/projects/${created.id}`, { data: { name: "" } });
    expect(patchRes.ok()).toBeTruthy();

    const getRes = await request.get(`/api/projects/${created.id}`);
    expect((await getRes.json()).name).toBe("");

    await request.delete(`/api/projects/${created.id}`);
  });

  test("updating or deleting a project that doesn't exist returns 404", async ({ request }) => {
    const missingId = "00000000-0000-0000-0000-000000000000";

    const patchRes = await request.patch(`/api/projects/${missingId}`, {
      data: { name: "nope" },
      failOnStatusCode: false,
    });
    expect(patchRes.status()).toBe(404);

    const deleteRes = await request.delete(`/api/projects/${missingId}`, { failOnStatusCode: false });
    expect(deleteRes.status()).toBe(404);
  });
});
