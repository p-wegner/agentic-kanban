import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Ready for Merge — API", () => {
  let projectId: string;
  let statusId: string;
  let issueId: string;
  let workspaceId: string;
  const suffix = Date.now().toString(36);

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
    const projects = await projectsRes.json();
    projectId = projects[0].id;

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todoStatus ? todoStatus.id : statuses[0].id;

    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `Ready-for-merge test issue ${suffix}`,
        statusId,
        projectId,
      },
    });
    issueId = (await issueRes.json()).id;

    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: {
        issueId,
        branch: `feature/ready-merge-test-${suffix}`,
      },
    });
    expect(wsRes.status()).toBe(201);
    workspaceId = (await wsRes.json()).id;
  });

  test.afterAll(async ({ request }) => {
    if (workspaceId) {
      await request.delete(`${SERVER_URL}/api/workspaces/${workspaceId}`);
    }
    if (issueId) {
      await request.delete(`${SERVER_URL}/api/issues/${issueId}`);
    }
  });

  test("workspace starts with readyForMerge=false", async ({ request }) => {
    const res = await request.get(`${SERVER_URL}/api/workspaces/${workspaceId}`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.readyForMerge).toBe(false);
  });

  test("POST /api/workspaces/:id/ready-for-merge sets readyForMerge=true", async ({
    request,
  }) => {
    const res = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/ready-for-merge`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.readyForMerge).toBe(true);
  });

  test("workspace GET reflects readyForMerge=true after marking", async ({
    request,
  }) => {
    const res = await request.get(`${SERVER_URL}/api/workspaces/${workspaceId}`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.readyForMerge).toBe(true);
  });

  test("board workspaceSummary reflects readyForMerge=true", async ({
    request,
  }) => {
    const boardRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/board`,
    );
    expect(boardRes.ok()).toBeTruthy();
    const columns = await boardRes.json();
    const allIssues = (Array.isArray(columns) ? columns : []).flatMap(
      (c: { issues?: unknown[] }) => c.issues ?? [],
    );
    const issue = allIssues.find((i: { id: string }) => i.id === issueId) as {
      workspaceSummary?: { main?: { readyForMerge?: boolean } };
    };
    expect(issue).toBeDefined();
    expect(issue.workspaceSummary?.main?.readyForMerge).toBe(true);
  });

  test("POST /api/workspaces/:id/ready-for-merge returns 404 for unknown id", async ({
    request,
  }) => {
    const res = await request.post(
      `${SERVER_URL}/api/workspaces/00000000-0000-0000-0000-000000000000/ready-for-merge`,
    );
    expect(res.status()).toBe(404);
  });
});
