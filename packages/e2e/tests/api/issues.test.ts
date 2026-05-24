import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

test.describe("Issues API", () => {
  let projectId: string;
  let statusId: string;
  const createdIssueIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    projectId = await getE2EProjectId(request);

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    statusId = statuses[0].id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`).catch(() => {});
    }
  });

  test("GET /api/issues returns array for project", async ({ request }) => {
    const res = await request.get(
      `${SERVER_URL}/api/issues?projectId=${projectId}`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test("POST /api/issues creates an issue", async ({ request }) => {
    const suffix = Date.now().toString(36);
    const res = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `Test issue ${suffix}`,
        description: "A test issue",
        priority: "high",
        statusId,
        projectId,
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.title).toBe(`Test issue ${suffix}`);
    expect(body.id).toBeDefined();
    createdIssueIds.push(body.id);
  });

  test("GET /api/issues returns created issue", async ({ request }) => {
    const suffix = Date.now().toString(36);
    const createRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `Another issue ${suffix}`,
        statusId,
        projectId,
      },
    });
    const created = await createRes.json();
    createdIssueIds.push(created.id);

    const res = await request.get(
      `${SERVER_URL}/api/issues?projectId=${projectId}`,
    );
    const body = await res.json();
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body.some((i: { id: string }) => i.id === created.id)).toBeTruthy();
  });

  test("PATCH /api/issues/:id updates an issue", async ({ request }) => {
    const suffix = Date.now().toString(36);
    const createRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `To update ${suffix}`,
        statusId,
        projectId,
      },
    });
    const { id } = await createRes.json();
    createdIssueIds.push(id);

    const updateRes = await request.patch(
      `${SERVER_URL}/api/issues/${id}`,
      {
        data: { title: `Updated ${suffix}`, priority: "critical" },
      },
    );
    expect(updateRes.ok()).toBeTruthy();
  });

  test("POST /api/issues creates issue with estimate", async ({ request }) => {
    const suffix = Date.now().toString(36);
    const res = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `Estimated ${suffix}`, statusId, projectId, estimate: "L" },
    });
    expect(res.status()).toBe(201);
    const { id } = await res.json();
    createdIssueIds.push(id);

    const listRes = await request.get(`${SERVER_URL}/api/issues?projectId=${projectId}`);
    const list = await listRes.json();
    const issue = list.find((i: { id: string }) => i.id === id);
    expect(issue.estimate).toBe("L");
  });

  test("PATCH /api/issues/:id sets and clears estimate", async ({ request }) => {
    const suffix = Date.now().toString(36);
    const createRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `Estimate patch ${suffix}`, statusId, projectId },
    });
    const { id } = await createRes.json();
    createdIssueIds.push(id);

    // set estimate
    const setRes = await request.patch(`${SERVER_URL}/api/issues/${id}`, {
      data: { estimate: "XS" },
    });
    expect(setRes.ok()).toBeTruthy();

    const listAfterSet = await (await request.get(`${SERVER_URL}/api/issues?projectId=${projectId}`)).json();
    expect(listAfterSet.find((i: { id: string }) => i.id === id).estimate).toBe("XS");

    // clear estimate
    await request.patch(`${SERVER_URL}/api/issues/${id}`, { data: { estimate: null } });
    const listAfterClear = await (await request.get(`${SERVER_URL}/api/issues?projectId=${projectId}`)).json();
    expect(listAfterClear.find((i: { id: string }) => i.id === id).estimate).toBeNull();
  });

  test("DELETE /api/issues/:id deletes an issue", async ({ request }) => {
    const suffix = Date.now().toString(36);
    const createRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `To delete ${suffix}`,
        statusId,
        projectId,
      },
    });
    const { id } = await createRes.json();

    const deleteRes = await request.delete(
      `${SERVER_URL}/api/issues/${id}`,
    );
    expect(deleteRes.ok()).toBeTruthy();
  });
});
