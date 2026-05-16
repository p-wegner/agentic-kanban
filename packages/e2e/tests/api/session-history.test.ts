import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Session History API", () => {
  let projectId: string;
  let statusId: string;
  let issueId: string;
  let workspaceId: string;
  const suffix = Date.now().toString(36);
  const extraIssueIds: string[] = [];
  const extraWorkspaceIds: string[] = [];

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
      data: { title: `Session history test issue ${suffix}`, statusId, projectId },
    });
    issueId = (await issueRes.json()).id;

    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId, branch: `feature/session-history-test-${suffix}` },
    });
    expect(wsRes.status()).toBe(201);
    workspaceId = (await wsRes.json()).id;

    let setupOk = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const setupRes = await request.post(
        `${SERVER_URL}/api/workspaces/${workspaceId}/setup`,
        { data: {} },
      );
      if (setupRes.status() === 200) {
        setupOk = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(setupOk).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    for (const id of extraWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`);
    }
    for (const id of extraIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
    if (workspaceId) {
      await request.delete(`${SERVER_URL}/api/workspaces/${workspaceId}`);
    }
    if (issueId) {
      await request.delete(`${SERVER_URL}/api/issues/${issueId}`);
    }
  });

  test("GET /api/sessions/:id/output returns 404 for unknown session", async ({
    request,
  }) => {
    const res = await request.get(
      `${SERVER_URL}/api/sessions/nonexistent-session-id/output`,
    );
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Session not found");
  });

  test("GET /api/sessions/:id/output returns persisted messages after mock agent run", async ({
    request,
  }) => {
    const launchRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/launch`,
      {
        data: {
          prompt: "echo hello",
          agentCommand: "node -e \"console.log('mock output'); process.exit(0)\"",
        },
      },
    );
    expect(launchRes.status()).toBe(201);

    const { sessionId } = await launchRes.json();
    expect(sessionId).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 3000));

    let messages: any[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const outputRes = await request.get(
        `${SERVER_URL}/api/sessions/${sessionId}/output`,
      );
      expect(outputRes.status()).toBe(200);
      messages = await outputRes.json();
      if (messages.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeGreaterThan(0);

    for (const msg of messages) {
      expect(msg).toHaveProperty("type");
      expect(msg).toHaveProperty("sessionId");
      expect(["stdout", "stderr", "exit"]).toContain(msg.type);
    }

    const exitMessages = messages.filter(
      (m: { type: string }) => m.type === "exit",
    );
    expect(exitMessages.length).toBeGreaterThan(0);

    await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/stop`,
      { data: {} },
    );
  });

  test("messages persist in database (output available after session ends)", async ({
    request,
  }) => {
    const persistSuffix = Date.now().toString(36);
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `Persistence test issue ${persistSuffix}`, statusId, projectId },
    });
    const testIssueId = (await issueRes.json()).id;
    extraIssueIds.push(testIssueId);

    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId: testIssueId, branch: `feature/persistence-test-${persistSuffix}` },
    });
    const testWorkspaceId = (await wsRes.json()).id;
    extraWorkspaceIds.push(testWorkspaceId);

    let setupOk = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const setupRes = await request.post(
        `${SERVER_URL}/api/workspaces/${testWorkspaceId}/setup`,
        { data: {} },
      );
      if (setupRes.status() === 200) {
        setupOk = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(setupOk).toBe(true);

    const launchRes = await request.post(
      `${SERVER_URL}/api/workspaces/${testWorkspaceId}/launch`,
      {
        data: {
          prompt: "persistence test",
          agentCommand: "node -e \"console.log('persist me'); process.exit(0)\"",
        },
      },
    );
    expect(launchRes.status()).toBe(201);

    const { sessionId } = await launchRes.json();

    await new Promise((resolve) => setTimeout(resolve, 3000));

    let messages: any[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const outputRes = await request.get(
        `${SERVER_URL}/api/sessions/${sessionId}/output`,
      );
      expect(outputRes.status()).toBe(200);
      messages = await outputRes.json();
      if (messages.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    expect(messages.length).toBeGreaterThan(0);
  });
});
