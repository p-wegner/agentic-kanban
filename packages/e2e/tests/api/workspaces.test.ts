import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

test.describe("Workspaces API", () => {
  let projectId: string;
  let statusId: string;
  let issueId: string;
  const suffix = Date.now().toString(36);
  const createdWorkspaceIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    projectId = await getE2EProjectId(request);

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todoStatus ? todoStatus.id : statuses[0].id;

    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `Workspace test issue ${suffix}`,
        statusId,
        projectId,
      },
    });
    issueId = (await issueRes.json()).id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`).catch(() => {});
    }
    if (issueId) {
      await request.delete(`${SERVER_URL}/api/issues/${issueId}`).catch(() => {});
    }
  });

  test("POST /api/workspaces creates a workspace", async ({ request }) => {
    const res = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: {
        issueId,
        branch: `feature/test-branch-${suffix}`,
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.branch).toBe(`feature/test-branch-${suffix}`);
    expect(body.status).toBe("active");
    expect(body.id).toBeDefined();
    createdWorkspaceIds.push(body.id);
  });

  test("POST /api/workspaces requires issueId and branch", async ({
    request,
  }) => {
    const res = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId },
    });
    expect(res.status()).toBe(400);
  });

  test("GET /api/workspaces/:id returns workspace with issue info", async ({
    request,
  }) => {
    const createRes = await request.post(
      `${SERVER_URL}/api/workspaces`,
      {
        data: {
          issueId,
          branch: `feature/get-test-${suffix}`,
        },
      },
    );
    const { id } = await createRes.json();
    createdWorkspaceIds.push(id);

    const res = await request.get(`${SERVER_URL}/api/workspaces/${id}`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.branch).toBe(`feature/get-test-${suffix}`);
    expect(body.issue.title).toBe(`Workspace test issue ${suffix}`);
  });

  test("GET /api/issues/:id/workspaces lists workspaces", async ({
    request,
  }) => {
    const res = await request.get(
      `${SERVER_URL}/api/issues/${issueId}/workspaces`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  test("PATCH /api/workspaces/:id updates status", async ({ request }) => {
    const createRes = await request.post(
      `${SERVER_URL}/api/workspaces`,
      {
        data: {
          issueId,
          branch: `feature/patch-test-${suffix}`,
        },
      },
    );
    const { id } = await createRes.json();
    createdWorkspaceIds.push(id);

    const res = await request.patch(
      `${SERVER_URL}/api/workspaces/${id}`,
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
      `${SERVER_URL}/api/workspaces`,
      {
        data: {
          issueId,
          branch: `feature/delete-test-${suffix}`,
        },
      },
    );
    const { id } = await createRes.json();

    const res = await request.delete(
      `${SERVER_URL}/api/workspaces/${id}`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.success).toBe(true);
    // Don't push to createdWorkspaceIds — already deleted
  });
});
