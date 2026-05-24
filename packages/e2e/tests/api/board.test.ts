import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

test.describe("Board API", () => {
  let projectId: string;
  let todoStatusId: string;
  let doneStatusId: string;
  const createdIssueIds: string[] = [];
  const suffix = Date.now().toString(36);

  test.beforeAll(async ({ request }) => {
    projectId = await getE2EProjectId(request);

    const todoRes = await request.post(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
      { data: { name: `Board Todo ${suffix}`, sortOrder: 0 } },
    );
    todoStatusId = (await todoRes.json()).id;

    const doneRes = await request.post(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
      { data: { name: `Board Done ${suffix}`, sortOrder: 1 } },
    );
    doneStatusId = (await doneRes.json()).id;

    const issue1Res = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `Board task 1 ${suffix}`, statusId: todoStatusId, projectId },
    });
    createdIssueIds.push((await issue1Res.json()).id);

    const issue2Res = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `Board task 2 ${suffix}`, statusId: doneStatusId, projectId },
    });
    createdIssueIds.push((await issue2Res.json()).id);
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`).catch(() => {});
    }
    // Delete the custom statuses created for this test (issues must be deleted first).
    await request.delete(`${SERVER_URL}/api/projects/${projectId}/statuses/${todoStatusId}`).catch(() => {});
    await request.delete(`${SERVER_URL}/api/projects/${projectId}/statuses/${doneStatusId}`).catch(() => {});
    // Fetch and delete the third status created inline in the test
    const boardRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/board`).catch(() => null);
    if (boardRes?.ok()) {
      const board: Array<{ id: string; name: string }> = await boardRes.json();
      const reviewCol = board.find((s) => s.name === `Review ${suffix}`);
      if (reviewCol) {
        await request.delete(`${SERVER_URL}/api/projects/${projectId}/statuses/${reviewCol.id}`).catch(() => {});
      }
    }
  });

  test("GET /api/projects/:id/board returns statuses with nested issues", async ({
    request,
  }) => {
    const res = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/board`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    const todoCol = body.find((s: { name: string }) => s.name === `Board Todo ${suffix}`);
    const doneCol = body.find((s: { name: string }) => s.name === `Board Done ${suffix}`);
    expect(todoCol).toBeDefined();
    expect(todoCol.issues.length).toBe(1);
    expect(todoCol.issues[0].title).toBe(`Board task 1 ${suffix}`);
    expect(todoCol.issues[0].statusName).toBe(`Board Todo ${suffix}`);
    expect(doneCol).toBeDefined();
    expect(doneCol.issues.length).toBe(1);
  });

  test("GET /api/projects/:id/board returns 404 for missing project", async ({
    request,
  }) => {
    const res = await request.get(
      `${SERVER_URL}/api/projects/00000000-0000-0000-0000-000000000000/board`,
    );
    expect(res.status()).toBe(404);
  });

  test("Board endpoint includes all statuses even with no issues", async ({
    request,
  }) => {
    await request.post(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
      { data: { name: `Review ${suffix}`, sortOrder: 2 } },
    );

    const res = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/board`,
    );
    const body = await res.json();
    const reviewCol = body.find(
      (s: { name: string }) => s.name === `Review ${suffix}`,
    );
    expect(reviewCol).toBeDefined();
    expect(reviewCol.issues.length).toBe(0);
  });
});
