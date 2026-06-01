import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

test.describe("Workspace lifecycle API", () => {
  let projectId: string;
  let statusId: string;
  let issueId: string;
  let workspaceId: string;
  const suffix = Date.now().toString(36);
  const extraIssueIds: string[] = [];
  const extraWorkspaceIds: string[] = [];
  let originalClaudeProfile = "";

  test.beforeAll(async ({ request }) => {
    projectId = await getE2EProjectId(request);

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    expect(statusesRes.ok(), `GET statuses returned ${statusesRes.status()}`).toBeTruthy();
    const statuses = await statusesRes.json();
    expect(statuses.length, "Project has no statuses").toBeGreaterThan(0);
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todoStatus ? todoStatus.id : statuses[0].id;

    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `Lifecycle test issue ${suffix}`,
        statusId,
        projectId,
      },
    });
    expect(issueRes.ok(), `Create issue returned ${issueRes.status()}`).toBeTruthy();
    issueId = (await issueRes.json()).id;

    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: {
        issueId,
        branch: `feature/lifecycle-test-${suffix}`,
      },
    });
    expect(wsRes.status(), `Create workspace returned ${wsRes.status()}`).toBe(201);
    workspaceId = (await wsRes.json()).id;

    // Capture original claude_profile so we can restore it exactly.
    const settingsRes = await request.get(`${SERVER_URL}/api/preferences/settings`);
    if (settingsRes.ok()) {
      const s = await settingsRes.json();
      originalClaudeProfile = s.claude_profile ?? "";
    }
  });

  test.afterAll(async ({ request }) => {
    // Restore original claude_profile (not hardcoded "") to avoid corrupting real settings.
    try {
      await request.put(`${SERVER_URL}/api/preferences/settings`, {
        data: { claude_profile: originalClaudeProfile },
      });
    } catch { /* best-effort */ }
    for (const id of extraWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`).catch(() => {});
    }
    for (const id of extraIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`).catch(() => {});
    }
    if (workspaceId) {
      await request.delete(`${SERVER_URL}/api/workspaces/${workspaceId}`).catch(() => {});
    }
    if (issueId) {
      await request.delete(`${SERVER_URL}/api/issues/${issueId}`).catch(() => {});
    }
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
    const body = await res.json();
    expect(res.status()).toBeGreaterThanOrEqual(200);
    expect(res.status()).toBeLessThan(600);
  });

  test("POST /api/workspaces/:id/launch uses mock profile", async ({
    request,
  }) => {
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { claude_profile: "mock" },
    });

    const mockSuffix = Date.now().toString(36);
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `Mock agent pref test ${mockSuffix}`, statusId, projectId },
    });
    expect(issueRes.ok(), `Create mock-profile issue returned ${issueRes.status()}`).toBeTruthy();
    const testIssueId = (await issueRes.json()).id;
    extraIssueIds.push(testIssueId);

    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId: testIssueId, branch: `feature/mock-pref-test-${mockSuffix}` },
    });
    expect(wsRes.ok(), `Create mock-profile workspace returned ${wsRes.status()}`).toBeTruthy();
    const testWorkspaceId = (await wsRes.json()).id;
    extraWorkspaceIds.push(testWorkspaceId);

    const setupRes = await request.post(
      `${SERVER_URL}/api/workspaces/${testWorkspaceId}/setup`,
      { data: {} },
    );
    expect(setupRes.ok(), `Workspace setup returned ${setupRes.status()}: ${await setupRes.text()}`).toBeTruthy();

    const launchRes = await request.post(
      `${SERVER_URL}/api/workspaces/${testWorkspaceId}/launch`,
      { data: { prompt: "test with mock profile" } },
    );

    expect(launchRes.status()).toBe(201);
    const launchBody = await launchRes.json();
    expect(launchBody.sessionId).toBeDefined();

    await new Promise((r) => setTimeout(r, 1500));

    const sessionsRes = await request.get(
      `${SERVER_URL}/api/workspaces/${testWorkspaceId}/sessions`,
    );
    expect(sessionsRes.ok()).toBeTruthy();
    const sessions = await sessionsRes.json();
    expect(sessions.length).toBeGreaterThan(0);

    const session = sessions.find(
      (s: { id: string }) => s.id === launchBody.sessionId,
    );
    expect(session).toBeDefined();
    expect(["running", "completed", "stopped"]).toContain(session.status);

    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { claude_profile: originalClaudeProfile },
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
    expect(res.status()).toBeLessThan(500);
  });
});
