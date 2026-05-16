import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Settings API", () => {
  test("GET /api/preferences/settings returns defaults", async ({ request }) => {
    const res = await request.get(`${SERVER_URL}/api/preferences/settings`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    // Should return an object (may be empty or have existing saved values)
    expect(typeof body).toBe("object");
  });

  test("PUT /api/preferences/settings saves settings", async ({ request }) => {
    const res = await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: {
        agent_command: "claude-test",
        agent_args: "--model opus",
        output_parser: "true",
        mock_agent: "false",
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("GET /api/preferences/settings returns saved values", async ({ request }) => {
    // First save
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: {
        agent_command: "claude-verify",
        agent_args: "--verbose",
        output_parser: "false",
        mock_agent: "true",
      },
    });

    // Then read back
    const res = await request.get(`${SERVER_URL}/api/preferences/settings`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.agent_command).toBe("claude-verify");
    expect(body.agent_args).toBe("--verbose");
    expect(body.output_parser).toBe("false");
    expect(body.mock_agent).toBe("true");
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
    // Save agent_command preference
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: {
        agent_command: 'node -e "console.log(\'pref-agent\')"',
        mock_agent: "false",
      },
    });

    // Create issue + workspace
    const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
    const projects = await projectsRes.json();
    const projectId = projects[0].id;

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    const statusId = todoStatus ? todoStatus.id : statuses[0].id;

    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: "Settings agent test", statusId, projectId },
    });
    const issueId = (await issueRes.json()).id;

    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId, branch: "feature/settings-agent-test" },
    });
    const workspaceId = (await wsRes.json()).id;

    // Setup worktree so launch has a workingDir
    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/setup`, {
      data: {},
    });

    // Launch with no explicit agentCommand — should use preference
    const launchRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/launch`,
      { data: { prompt: "test prompt" } },
    );

    // Should succeed (201) since agent_command pref provides a valid command
    expect(launchRes.status()).toBe(201);
    const launchBody = await launchRes.json();
    expect(launchBody.sessionId).toBeDefined();
  });
});

test.afterAll(async ({ request }) => {
  // Clean up: reset settings to defaults
  await request.put(`${SERVER_URL}/api/preferences/settings`, {
    data: {
      agent_command: "",
      agent_args: "",
      output_parser: "true",
      mock_agent: "false",
    },
  });
});
