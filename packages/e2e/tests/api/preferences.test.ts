import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

test.describe("Preferences API", () => {
  let projectId: string;

  test.beforeAll(async ({ request }) => {
    // Use the dedicated E2E project set by global-setup (not projects[0] which may be a real project).
    projectId = await getE2EProjectId(request);
  });

  test("GET /api/preferences/active-project returns current active project", async ({
    request,
  }) => {
    const res = await request.get(
      `${SERVER_URL}/api/preferences/active-project`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    // Some value is set — the exact project may differ if another test registered one
    expect(body.projectId).toBeDefined();
    expect(typeof body.projectId).toBe("string");
    expect(body.projectId.length).toBeGreaterThan(0);
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
    // Restore the active project to the E2E project captured before any test corrupted it.
    try {
      await request.put(`${SERVER_URL}/api/preferences/active-project`, {
        data: { projectId },
      });
    } catch { /* best-effort */ }
  });
});
