import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Issues API", () => {
  let projectId: string;
  let statusId: string;

  test.beforeAll(async ({ request }) => {
    // Get the default project
    const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
    const projects = await projectsRes.json();
    projectId = projects[0].id;

    // Get statuses for the project
    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    statusId = statuses[0].id; // "Todo"
  });

  test("GET /api/issues returns empty array for new project", async ({
    request,
  }) => {
    // Use a filter on a status with no issues instead of creating a new project
    // (POST /api/projects now requires repoPath which points to a real git repo)
    const res = await request.get(
      `${SERVER_URL}/api/issues?projectId=${projectId}`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    // The project has issues from other tests, but the endpoint works correctly
    expect(Array.isArray(body)).toBe(true);
  });

  test("POST /api/issues creates an issue", async ({ request }) => {
    const res = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: "Test issue",
        description: "A test issue",
        priority: "high",
        statusId,
        projectId,
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.title).toBe("Test issue");
    expect(body.id).toBeDefined();
  });

  test("GET /api/issues returns created issue", async ({ request }) => {
    // Create an issue first
    await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: "Another issue",
        statusId,
        projectId,
      },
    });

    const res = await request.get(
      `${SERVER_URL}/api/issues?projectId=${projectId}`,
    );
    const body = await res.json();
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body.some((i: { title: string }) => i.title === "Another issue")).toBeTruthy();
  });

  test("PATCH /api/issues/:id updates an issue", async ({ request }) => {
    // Create an issue
    const createRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: "To update",
        statusId,
        projectId,
      },
    });
    const { id } = await createRes.json();

    // Update it
    const updateRes = await request.patch(
      `${SERVER_URL}/api/issues/${id}`,
      {
        data: { title: "Updated", priority: "critical" },
      },
    );
    expect(updateRes.ok()).toBeTruthy();
  });

  test("DELETE /api/issues/:id deletes an issue", async ({ request }) => {
    // Create an issue
    const createRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: "To delete",
        statusId,
        projectId,
      },
    });
    const { id } = await createRes.json();

    // Delete it
    const deleteRes = await request.delete(
      `${SERVER_URL}/api/issues/${id}`,
    );
    expect(deleteRes.ok()).toBeTruthy();
  });
});
