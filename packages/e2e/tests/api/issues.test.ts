import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Issues API", () => {
  let projectId: string;
  let statusId: string;
  const createdIssueIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
    const projects = await projectsRes.json();
    projectId = projects[0].id;

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    statusId = statuses[0].id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
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
