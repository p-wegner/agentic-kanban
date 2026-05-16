import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Preferences API", () => {
  let projectId: string;

  test.beforeAll(async ({ request }) => {
    // Get the default project (created by global-setup)
    const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
    const projects = await projectsRes.json();
    projectId = projects[0].id;
  });

  test("GET /api/preferences/active-project returns current active project", async ({
    request,
  }) => {
    const res = await request.get(
      `${SERVER_URL}/api/preferences/active-project`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.projectId).toBeDefined();
    // Should match the project set by global-setup
    expect(body.projectId).toBe(projectId);
  });

  test("PUT /api/preferences/active-project sets active project", async ({
    request,
  }) => {
    // Set the active project to the known project ID
    const res = await request.put(
      `${SERVER_URL}/api/preferences/active-project`,
      {
        data: { projectId },
      },
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.projectId).toBe(projectId);

    // Verify it was persisted
    const getRes = await request.get(
      `${SERVER_URL}/api/preferences/active-project`,
    );
    const getBody = await getRes.json();
    expect(getBody.projectId).toBe(projectId);
  });

  test("PUT /api/preferences/active-project with invalid ID still stores it", async ({
    request,
  }) => {
    // The API stores whatever value is passed (no validation against project list)
    const fakeId = "non-existent-project-id";
    const res = await request.put(
      `${SERVER_URL}/api/preferences/active-project`,
      {
        data: { projectId: fakeId },
      },
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.projectId).toBe(fakeId);
  });

  test.afterAll(async ({ request }) => {
    // Restore the active project to the correct one
    const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
    const projects = await projectsRes.json();
    if (projects.length > 0) {
      await request.put(
        `${SERVER_URL}/api/preferences/active-project`,
        {
          data: { projectId: projects[0].id },
        },
      );
    }
  });
});
