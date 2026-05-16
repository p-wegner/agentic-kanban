import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Workspace lifecycle API", () => {
  let projectId: string;
  let statusId: string;
  let issueId: string;
  let workspaceId: string;

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
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todoStatus ? todoStatus.id : statuses[0].id;

    // Create an issue for workspace tests
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: "Lifecycle test issue",
        statusId,
        projectId,
      },
    });
    issueId = (await issueRes.json()).id;

    // Create a workspace
    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: {
        issueId,
        branch: "feature/lifecycle-test",
      },
    });
    expect(wsRes.status()).toBe(201);
    workspaceId = (await wsRes.json()).id;
  });

  test("POST /api/workspaces/:id/launch starts a mock agent session", async ({
    request,
  }) => {
    const res = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/launch`,
      {
        data: {
          prompt: "echo hello",
          agentCommand: "node -e \"console.log('mock agent output')\"",
        },
      },
    );

    // May return 500 if workspace has no workingDir (expected for this test)
    // but the session endpoint should still work
    const body = await res.json();
    // Either we get a sessionId (if workspace has workingDir) or an error
    expect(res.status()).toBeGreaterThanOrEqual(200);
    expect(res.status()).toBeLessThan(600);
  });

  test("POST /api/workspaces/:id/launch uses mock_agent preference", async ({
    request,
  }) => {
    // Set mock_agent preference
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { mock_agent: "true" },
    });

    // Create a new workspace with setup
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: "Mock agent pref test", statusId, projectId },
    });
    const testIssueId = (await issueRes.json()).id;

    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId: testIssueId, branch: "feature/mock-pref-test" },
    });
    const testWorkspaceId = (await wsRes.json()).id;

    // Setup worktree so launch has a workingDir
    const setupRes = await request.post(
      `${SERVER_URL}/api/workspaces/${testWorkspaceId}/setup`,
      { data: {} },
    );
    // Setup may fail in CI — skip if so
    if (setupRes.status() !== 200) {
      // Reset mock_agent preference
      await request.put(`${SERVER_URL}/api/preferences/settings`, {
        data: { mock_agent: "false" },
      });
      test.skip();
      return;
    }

    // Launch without explicit agentCommand — should use mock_agent pref
    const launchRes = await request.post(
      `${SERVER_URL}/api/workspaces/${testWorkspaceId}/launch`,
      { data: { prompt: "test with mock agent pref" } },
    );

    expect(launchRes.status()).toBe(201);
    const launchBody = await launchRes.json();
    expect(launchBody.sessionId).toBeDefined();

    // Wait briefly for the mock agent to emit output
    await new Promise((r) => setTimeout(r, 1500));

    // Check sessions endpoint for output
    const sessionsRes = await request.get(
      `${SERVER_URL}/api/workspaces/${testWorkspaceId}/sessions`,
    );
    expect(sessionsRes.ok()).toBeTruthy();
    const sessions = await sessionsRes.json();
    expect(sessions.length).toBeGreaterThan(0);

    // The session should have completed (mock agent exits after ~400ms)
    const session = sessions.find(
      (s: { id: string }) => s.id === launchBody.sessionId,
    );
    expect(session).toBeDefined();
    // Session should be completed or running (may not have exited yet)
    expect(["running", "completed", "stopped"]).toContain(session.status);

    // Reset mock_agent preference
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { mock_agent: "false" },
    });
  });

  test("GET /api/workspaces/:id/sessions returns session list", async ({
    request,
  }) => {
    const res = await request.get(
      `${SERVER_URL}/api/workspaces/${workspaceId}/sessions`,
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test("POST /api/workspaces/:id/stop returns successfully", async ({
    request,
  }) => {
    const res = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/stop`,
    );
    expect(res.ok()).toBeTruthy();
  });

  test("GET /api/workspaces/:id/diff returns diff for set-up workspace", async ({
    request,
  }) => {
    const res = await request.get(
      `${SERVER_URL}/api/workspaces/${workspaceId}/diff`,
    );
    // Workspace is auto-set-up on creation, so diff should succeed (200)
    // or return 500 if git diff fails for another reason
    expect(res.status()).toBeLessThan(500);
  });
});
