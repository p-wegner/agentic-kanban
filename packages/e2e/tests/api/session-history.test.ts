import { test, expect } from "@playwright/test";

test.describe("Session History API", () => {
  let projectId: string;
  let statusId: string;
  let issueId: string;
  let workspaceId: string;

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

    // Create an issue
    const issueRes = await request.post("http://localhost:3001/api/issues", {
      data: { title: "Session history test issue", statusId, projectId },
    });
    issueId = (await issueRes.json()).id;

    // Create a workspace
    const wsRes = await request.post("http://localhost:3001/api/workspaces", {
      data: { issueId, branch: "feature/session-history-test" },
    });
    expect(wsRes.status()).toBe(201);
    workspaceId = (await wsRes.json()).id;

    // Setup workspace (git worktree) with retries
    let setupOk = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const setupRes = await request.post(
        `http://localhost:3001/api/workspaces/${workspaceId}/setup`,
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

  test("GET /api/sessions/:id/output returns 404 for unknown session", async ({
    request,
  }) => {
    const res = await request.get(
      "http://localhost:3001/api/sessions/nonexistent-session-id/output",
    );
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Session not found");
  });

  test("GET /api/sessions/:id/output returns persisted messages after mock agent run", async ({
    request,
  }) => {
    // Launch with a simple command that exits quickly
    const launchRes = await request.post(
      `http://localhost:3001/api/workspaces/${workspaceId}/launch`,
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

    // Wait for the session to complete and messages to be persisted
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Fetch session output (with retry for async DB persistence)
    let messages: any[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const outputRes = await request.get(
        `http://localhost:3001/api/sessions/${sessionId}/output`,
      );
      expect(outputRes.status()).toBe(200);
      messages = await outputRes.json();
      if (messages.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeGreaterThan(0);

    // Verify message structure
    for (const msg of messages) {
      expect(msg).toHaveProperty("type");
      expect(msg).toHaveProperty("sessionId");
      expect(["stdout", "stderr", "exit"]).toContain(msg.type);
    }

    // Should have an exit message
    const exitMessages = messages.filter(
      (m: { type: string }) => m.type === "exit",
    );
    expect(exitMessages.length).toBeGreaterThan(0);

    // Cleanup: stop session if still running
    await request.post(
      `http://localhost:3001/api/workspaces/${workspaceId}/stop`,
      { data: {} },
    );
  });

  test("messages persist in database (output available after session ends)", async ({
    request,
  }) => {
    // Create a fresh workspace for this test
    const issueRes = await request.post("http://localhost:3001/api/issues", {
      data: { title: "Persistence test issue", statusId, projectId },
    });
    const testIssueId = (await issueRes.json()).id;

    const wsRes = await request.post("http://localhost:3001/api/workspaces", {
      data: { issueId: testIssueId, branch: "feature/persistence-test" },
    });
    const testWorkspaceId = (await wsRes.json()).id;

    // Setup workspace with retries
    let setupOk = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const setupRes = await request.post(
        `http://localhost:3001/api/workspaces/${testWorkspaceId}/setup`,
        { data: {} },
      );
      if (setupRes.status() === 200) {
        setupOk = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(setupOk).toBe(true);

    // Launch agent
    const launchRes = await request.post(
      `http://localhost:3001/api/workspaces/${testWorkspaceId}/launch`,
      {
        data: {
          prompt: "persistence test",
          agentCommand: "node -e \"console.log('persist me'); process.exit(0)\"",
        },
      },
    );
    expect(launchRes.status()).toBe(201);

    const { sessionId } = await launchRes.json();

    // Wait for completion
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Verify output is available (with retry for async DB persistence)
    let messages: any[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const outputRes = await request.get(
        `http://localhost:3001/api/sessions/${sessionId}/output`,
      );
      expect(outputRes.status()).toBe(200);
      messages = await outputRes.json();
      if (messages.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    expect(messages.length).toBeGreaterThan(0);
  });
});
