import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const ctx = JSON.parse(fs.readFileSync(path.join(__dirname, "../.auth/context.json"), "utf-8"));

test.describe("test case CRUD", () => {
  test("supports the create -> read -> update -> list -> delete lifecycle", async ({ request }) => {
    const title = `E2E smoke test case ${Date.now()}`;

    const createRes = await request.post(`/api/projects/${ctx.projectId}/testcases`, {
      data: { title },
    });
    expect(createRes.ok()).toBeTruthy();
    const created = await createRes.json();
    expect(created.id).toBeTruthy();
    const testcaseId = created.id;

    const getRes = await request.get(`/api/projects/${ctx.projectId}/testcases/${testcaseId}`);
    expect(getRes.ok()).toBeTruthy();
    expect((await getRes.json()).title).toBe(title);

    const updatedTitle = `${title} (updated)`;
    const putRes = await request.put(`/api/projects/${ctx.projectId}/testcases/${testcaseId}`, {
      data: { title: updatedTitle },
    });
    expect(putRes.ok()).toBeTruthy();

    const getAfterUpdateRes = await request.get(
      `/api/projects/${ctx.projectId}/testcases/${testcaseId}`,
    );
    expect((await getAfterUpdateRes.json()).title).toBe(updatedTitle);

    const listRes = await request.get(`/api/projects/${ctx.projectId}/testcases`, {
      params: { search: updatedTitle },
    });
    expect(listRes.ok()).toBeTruthy();
    const list = await listRes.json();
    expect(list.some((tc: { id: string }) => tc.id === testcaseId)).toBeTruthy();

    const deleteRes = await request.delete(`/api/projects/${ctx.projectId}/testcases/${testcaseId}`);
    expect(deleteRes.ok()).toBeTruthy();

    const getAfterDeleteRes = await request.get(
      `/api/projects/${ctx.projectId}/testcases/${testcaseId}`,
    );
    expect(getAfterDeleteRes.status()).toBe(404);
  });
});
