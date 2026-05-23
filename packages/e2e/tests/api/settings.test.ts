import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Settings API", () => {
  const createdIssueIds: string[] = [];
  const createdWorkspaceIds: string[] = [];

  test.afterAll(async ({ request }) => {
    // Clean up issues/workspaces created during tests
    for (const id of createdWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`);
    }
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
    // Reset settings to defaults
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: {
        agent_command: "",
        agent_args: "",
        output_parser: "true",
        claude_profile: "",
      },
    });
  });

  test("GET /api/preferences/settings returns defaults", async ({ request }) => {
    const res = await request.get(`${SERVER_URL}/api/preferences/settings`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(typeof body).toBe("object");
  });

  test("PUT /api/preferences/settings saves settings", async ({ request }) => {
    const res = await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: {
        agent_command: "claude-test",
        agent_args: "--model opus",
        output_parser: "true",
        claude_profile: "",
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("GET /api/preferences/settings returns saved values", async ({ request }) => {
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: {
        agent_command: "claude-verify",
        agent_args: "--verbose",
        output_parser: "false",
        claude_profile: "mock",
      },
    });

    const res = await request.get(`${SERVER_URL}/api/preferences/settings`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.agent_command).toBe("claude-verify");
    expect(body.agent_args).toBe("--verbose");
    expect(body.output_parser).toBe("false");
    expect(body.claude_profile).toBe("mock");
  });

  test("PUT only persists allowed keys", async ({ request }) => {
    const res = await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: {
        agent_command: "claude-safe",
        evil_key: "should be ignored",
      },
    });
    expect(res.ok()).toBeTruthy();

    const getRes = await request.get(`${SERVER_URL}/api/preferences/settings`);
    const body = await getRes.json();
    expect(body.evil_key).toBeUndefined();
  });

  test("workspace launch uses agent_command from preferences", async ({ request }) => {
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: {
        agent_command: 'node -e "console.log(\'pref-agent\')"',
        claude_profile: "",
      },
    });

    const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
    const projects = await projectsRes.json();
    const projectId = projects[0].id;

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    const statusId = todoStatus ? todoStatus.id : statuses[0].id;

    const suffix = Date.now().toString(36);
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `Settings agent test ${suffix}`, statusId, projectId },
    });
    const issueId = (await issueRes.json()).id;
    createdIssueIds.push(issueId);

    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId, branch: `feature/settings-agent-test-${suffix}` },
    });
    const workspaceId = (await wsRes.json()).id;
    createdWorkspaceIds.push(workspaceId);

    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/setup`, {
      data: {},
    });

    const launchRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/launch`,
      { data: { prompt: "test prompt" } },
    );

    expect(launchRes.status()).toBe(201);
    const launchBody = await launchRes.json();
    expect(launchBody.sessionId).toBeDefined();
  });
});
