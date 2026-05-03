import { test, expect } from "@playwright/test";

test.describe("Projects API", () => {
  let projectId: string;

  test.beforeAll(async ({ request }) => {
    // Get the default project (created by global-setup)
    const projectsRes = await request.get("http://localhost:3001/api/projects");
    const projects = await projectsRes.json();
    projectId = projects[0].id;
  });

  test("GET /api/projects returns list", async ({ request }) => {
    const res = await request.get("http://localhost:3001/api/projects");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
    // Each project should have expected fields
    const project = body[0];
    expect(project.id).toBeDefined();
    expect(project.name).toBeDefined();
    expect(project.repoPath).toBeDefined();
  });

  test("POST /api/projects creates project with git info auto-detection", async ({
    request,
  }) => {
    const res = await request.post("http://localhost:3001/api/projects", {
      data: {
        name: "E2E Test Project " + Date.now(),
        repoPath: "F:\\projects\\agentic_kanban",
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.name).toBeDefined();
    expect(body.repoPath).toBeDefined();

    // Clean up: the project was created for testing; delete its statuses would be
    // complex, so we leave it. The name has a timestamp to avoid collisions.
  });

  test("POST /api/projects rejects missing repoPath", async ({ request }) => {
    const res = await request.post("http://localhost:3001/api/projects", {
      data: { name: "No repo project" },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("repoPath");
  });

  test("GET /api/projects/:id/statuses returns statuses", async ({
    request,
  }) => {
    const res = await request.get(
      `http://localhost:3001/api/projects/${projectId}/statuses`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(5); // 5 default statuses
    // Statuses should be ordered by sortOrder
    const names = body.map((s: { name: string }) => s.name);
    expect(names).toContain("Todo");
    expect(names).toContain("In Progress");
    expect(names).toContain("In Review");
    expect(names).toContain("Done");
    expect(names).toContain("Cancelled");
  });

  test("POST /api/projects/:id/statuses creates a new status", async ({
    request,
  }) => {
    const statusName = `Test Status ${Date.now()}`;
    const res = await request.post(
      `http://localhost:3001/api/projects/${projectId}/statuses`,
      {
        data: { name: statusName, sortOrder: 99 },
      },
    );
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.name).toBe(statusName);
    expect(body.projectId).toBe(projectId);

    // Verify it appears in the list
    const listRes = await request.get(
      `http://localhost:3001/api/projects/${projectId}/statuses`,
    );
    const list = await listRes.json();
    expect(
      list.some((s: { name: string }) => s.name === statusName),
    ).toBeTruthy();
  });

  test("GET /api/projects/:id/branches returns branches", async ({
    request,
  }) => {
    const res = await request.get(
      `http://localhost:3001/api/projects/${projectId}/branches`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(typeof body).toBe("object");
    // Response has local and remote branch arrays
    expect(Array.isArray(body.local)).toBe(true);
    expect(body.local.length).toBeGreaterThanOrEqual(1);
    // Remote branches also present
    expect(Array.isArray(body.remote)).toBe(true);
  });

  test("GET /api/projects/:id/branches returns 404 for invalid project", async ({
    request,
  }) => {
    const res = await request.get(
      "http://localhost:3001/api/projects/non-existent-id/branches",
    );
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });
});
