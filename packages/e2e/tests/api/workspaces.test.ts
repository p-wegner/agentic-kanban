import { test, expect } from "@playwright/test";

test.describe("Workspaces API", () => {
  let projectId: string;
  let statusId: string;
  let issueId: string;

  test.beforeAll(async ({ request }) => {
    // Get the default project
    const projectsRes = await request.get("http://localhost:3001/api/projects");
    const projects = await projectsRes.json();
    projectId = projects[0].id;

    // Get statuses for the project
    const statusesRes = await request.get(
      `http://localhost:3001/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todoStatus ? todoStatus.id : statuses[0].id;

    // Create an issue for workspace tests
    const issueRes = await request.post("http://localhost:3001/api/issues", {
      data: {
        title: "Workspace test issue",
        statusId,
        projectId,
      },
    });
    issueId = (await issueRes.json()).id;
  });

  test("POST /api/workspaces creates a workspace", async ({ request }) => {
    const res = await request.post("http://localhost:3001/api/workspaces", {
      data: {
        issueId,
        branch: "feature/test-branch",
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.branch).toBe("feature/test-branch");
    expect(body.status).toBe("active");
    expect(body.id).toBeDefined();
  });

  test("POST /api/workspaces requires issueId and branch", async ({
    request,
  }) => {
    const res = await request.post("http://localhost:3001/api/workspaces", {
      data: { issueId },
    });
    expect(res.status()).toBe(400);
  });

  test("GET /api/workspaces/:id returns workspace with issue info", async ({
    request,
  }) => {
    // Create workspace
    const createRes = await request.post(
      "http://localhost:3001/api/workspaces",
      {
        data: {
          issueId,
          branch: "feature/get-test",
        },
      },
    );
    const { id } = await createRes.json();

    const res = await request.get(`http://localhost:3001/api/workspaces/${id}`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.branch).toBe("feature/get-test");
    expect(body.issue.title).toBe("Workspace test issue");
  });

  test("GET /api/issues/:id/workspaces lists workspaces", async ({
    request,
  }) => {
    const res = await request.get(
      `http://localhost:3001/api/issues/${issueId}/workspaces`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  test("PATCH /api/workspaces/:id updates status", async ({ request }) => {
    const createRes = await request.post(
      "http://localhost:3001/api/workspaces",
      {
        data: {
          issueId,
          branch: "feature/patch-test",
        },
      },
    );
    const { id } = await createRes.json();

    const res = await request.patch(
      `http://localhost:3001/api/workspaces/${id}`,
      {
        data: { status: "idle" },
      },
    );
    expect(res.ok()).toBeTruthy();
  });

  test("DELETE /api/workspaces/:id deletes a workspace", async ({
    request,
  }) => {
    const createRes = await request.post(
      "http://localhost:3001/api/workspaces",
      {
        data: {
          issueId,
          branch: "feature/delete-test",
        },
      },
    );
    const { id } = await createRes.json();

    const res = await request.delete(
      `http://localhost:3001/api/workspaces/${id}`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});
