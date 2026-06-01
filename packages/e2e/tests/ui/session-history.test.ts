import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Session History UI", () => {
  let projectId: string;
  let statusId: string;
  const tmpFiles: string[] = [];
  const createdWorkspaceIds: string[] = [];
  const createdIssueIds: string[] = [];
  let originalProvider = "";
  let originalClaudeProfile = "";
  let originalMockAgentProfile = "";

  function buildCompletedAgentScript(output: string) {
    const sessionId = `mock-history-${Date.now().toString(36)}`;
    const assistantEvent = {
      type: "assistant",
      message: {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: output }],
        model: "mock-claude-opus-4",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    };
    const resultEvent = {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      result: output,
      session_id: sessionId,
      usage: { input_tokens: 1, output_tokens: 1 },
    };

    return [
      `console.log(${JSON.stringify(JSON.stringify(assistantEvent))});`,
      `console.log(${JSON.stringify(JSON.stringify(resultEvent))});`,
      "process.exit(0);",
    ].join("\n");
  }

  async function waitForNoRunningSessions(
    request: APIRequestContext,
    workspaceId: string,
  ) {
    await expect.poll(
      async () => {
        const sessionsRes = await request.get(
          `${SERVER_URL}/api/workspaces/${workspaceId}/sessions`,
        );
        if (!sessionsRes.ok()) return "sessions-unavailable";

        const sessions = await sessionsRes.json() as Array<{
          id: string;
          status: string;
          exitCode?: string | null;
          exit_code?: string | null;
        }>;
        const observed = sessions
          .map((s) => `${s.id}:${s.status}:${s.exitCode ?? s.exit_code ?? "no-exit-code"}`)
          .join(",");
        return sessions.some((s) => s.status === "running")
          ? `running sessions still present (${observed})`
          : "no running sessions";
      },
      {
        message: `Timed out waiting for workspace ${workspaceId} to have no running sessions`,
        timeout: 10000,
        intervals: [250, 500, 1000],
      },
    ).toBe("no running sessions");
  }

  async function waitForSessionCompletion(
    request: APIRequestContext,
    workspaceId: string,
    sessionId: string,
    expectedOutput: string,
  ) {
    await expect.poll(
      async () => {
        const sessionsRes = await request.get(
          `${SERVER_URL}/api/workspaces/${workspaceId}/sessions`,
        );
        if (!sessionsRes.ok()) return "sessions-unavailable";

        const sessions = await sessionsRes.json() as Array<{
          id: string;
          status: string;
          exitCode?: string | null;
          exit_code?: string | null;
        }>;
        const session = sessions.find((s) => s.id === sessionId);
        if (!session) return "session-missing";

        const outputRes = await request.get(
          `${SERVER_URL}/api/sessions/${sessionId}/output`,
        );
        if (!outputRes.ok()) return `output-${outputRes.status()}`;

        const messages = await outputRes.json();
        const hasExpectedOutput = messages.some(
          (m: { type: string; data?: string | null }) =>
            m.type === "stdout" && m.data?.includes(expectedOutput),
        );
        const hasExit = messages.some((m: { type: string }) => m.type === "exit");
        const exitCode = session.exitCode ?? session.exit_code;

        return [
          `status=${session.status}`,
          `exitCode=${String(exitCode ?? "missing")}`,
          `expectedTranscriptRow=${hasExpectedOutput ? "present" : "missing"}`,
          `exitTranscriptRow=${hasExit ? "present" : "missing"}`,
        ].join(":");
      },
      {
        message: `Timed out waiting for session ${sessionId} in workspace ${workspaceId} to complete with expected transcript rows`,
        timeout: 15000,
        intervals: [250, 500, 1000],
      },
    ).toBe(
      "status=completed:exitCode=0:expectedTranscriptRow=present:exitTranscriptRow=present",
    );
  }

  test.beforeAll(async ({ request }) => {
    const activeRes = await request.get(`${SERVER_URL}/api/preferences/active-project`);
    const { projectId: activeId } = await activeRes.json();
    projectId = activeId;

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todoStatus ? todoStatus.id : statuses[0].id;

    const settingsRes = await request.get(`${SERVER_URL}/api/preferences/settings`);
    if (settingsRes.ok()) {
      const settings = await settingsRes.json();
      originalProvider = settings.provider ?? "";
      originalClaudeProfile = settings.claude_profile ?? "";
      originalMockAgentProfile = settings.mock_agent_profile ?? "";
    }

    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { provider: "claude", claude_profile: "mock", mock_agent_profile: "" },
    });
  });

  async function openWorkspaceForIssue(page: Page, issueTitle: string, branchName: string) {
    const issueEl = page.locator("p", { hasText: issueTitle }).first();
    await issueEl.click();
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();

    await page.locator("button", { hasText: branchName }).first().click();

    await expect(page.locator("h2", { hasText: issueTitle })).toBeVisible({ timeout: 5000 });
  }

  async function stubWorkspacePanelMetadata(page: Page) {
    await page.route(/\/api\/workspaces\/[^/]+\/latest-commit$/, (route) =>
      route.fulfill({ json: { sha: null, message: null } }),
    );
    await page.route(/\/api\/workspaces\/[^/]+\/handoff$/, (route) =>
      route.fulfill({ json: { content: null } }),
    );
    await page.route(/\/api\/workspaces\/[^/]+\/plan$/, (route) =>
      route.fulfill({ json: { content: null } }),
    );
  }

  async function ensureWorkspaceSelected(page: Page, issueTitle: string, branchName: string) {
    const wsPanel = page
      .locator("h2", { hasText: issueTitle })
      .locator('xpath=ancestor::div[contains(@class, "fixed") and contains(@class, "z-50")][1]');
    const workspaceCard = wsPanel
      .locator("text=" + branchName)
      .first()
      .locator('xpath=ancestor::div[contains(@class, "border rounded")][1]');

    await expect(workspaceCard).toBeVisible({ timeout: 5000 });
    const className = await workspaceCard.getAttribute("class");
    if (!className?.includes("bg-blue-50")) {
      await workspaceCard.click();
    }

    return wsPanel;
  }

  test("completed sessions show in workspace panel", async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    const issueTitle = `History UI test ${suffix}`;
    const branchName = `feature/history-ui-${suffix}`;

    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: issueTitle, statusId, projectId, skipAutoReview: true },
    });
    const issueId = (await issueRes.json()).id;
    createdIssueIds.push(issueId);

    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId, branch: branchName, requiresReview: false },
    });
    const workspaceId = (await wsRes.json()).id;
    createdWorkspaceIds.push(workspaceId);

    // Setup workspace
    await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/setup`,
      { data: {} },
    );

    // Workspace creation auto-launches the configured mock agent.
    await waitForNoRunningSessions(request, workspaceId);

    // Launch and wait for completion (write to temp file to avoid Windows cmd.exe quoting issues)
    const script1 = buildCompletedAgentScript("history test output");
    const tmp1 = join(tmpdir(), `mock-agent-history-${Date.now()}.mjs`);
    writeFileSync(tmp1, script1);
    tmpFiles.push(tmp1);

    const launchRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/launch`,
      {
        data: {
          prompt: "test session history",
          agentCommand: `node ${tmp1.replace(/\\/g, '/')}`,
        },
      },
    );
    expect(launchRes.status()).toBe(201);

    const { sessionId } = await launchRes.json();
    await waitForSessionCompletion(
      request,
      workspaceId,
      sessionId,
      "history test output",
    );

    await stubWorkspacePanelMetadata(page);

    // Go to the board and open workspace panel
    await page.goto("/");
    await page.waitForSelector("h2");

    await openWorkspaceForIssue(page, issueTitle, branchName);

    const wsPanel = await ensureWorkspaceSelected(page, issueTitle, branchName);
    await expect(wsPanel.locator(`button[data-session-id="${sessionId}"]`)).toBeVisible({ timeout: 5000 });
  });

  test("click past session shows output in TerminalView", async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    const issueTitle = `History output test ${suffix}`;
    const branchName = `feature/history-output-${suffix}`;

    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: issueTitle, statusId, projectId, skipAutoReview: true },
    });
    const issueId = (await issueRes.json()).id;
    createdIssueIds.push(issueId);

    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId, branch: branchName, requiresReview: false },
    });
    const workspaceId = (await wsRes.json()).id;
    createdWorkspaceIds.push(workspaceId);

    // Setup workspace
    await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/setup`,
      { data: {} },
    );

    // Workspace creation auto-launches the configured mock agent.
    await waitForNoRunningSessions(request, workspaceId);

    // Launch and wait for completion (write to temp file to avoid Windows cmd.exe quoting issues)
    const script2 = buildCompletedAgentScript("viewable output");
    const tmp2 = join(tmpdir(), `mock-agent-output-${Date.now()}.mjs`);
    writeFileSync(tmp2, script2);
    tmpFiles.push(tmp2);

    const launchRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/launch`,
      {
        data: {
          prompt: "test output viewing",
          agentCommand: `node ${tmp2.replace(/\\/g, '/')}`,
        },
      },
    );
    expect(launchRes.status()).toBe(201);

    const { sessionId } = await launchRes.json();
    await waitForSessionCompletion(
      request,
      workspaceId,
      sessionId,
      "viewable output",
    );

    await stubWorkspacePanelMetadata(page);

    // Navigate and open workspace panel
    await page.goto("/");
    await page.waitForSelector("h2");

    await openWorkspaceForIssue(page, issueTitle, branchName);

    // Wait for the completed session to render, then open that historical output.
    const wsPanel = await ensureWorkspaceSelected(page, issueTitle, branchName);
    const completedSessionButton = wsPanel.locator(`button[data-session-id="${sessionId}"]`);
    await expect(completedSessionButton).toBeVisible({ timeout: 5000 });
    await completedSessionButton.click();

    // TerminalView should show "Disconnected" status (history output loaded inline)
    await expect(page.locator("text=Disconnected").first()).toBeVisible({ timeout: 5000 });
  });

  test.afterAll(async ({ request }) => {
    for (const f of tmpFiles) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
    for (const id of createdWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`).catch(() => {});
    }
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`).catch(() => {});
    }
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: {
        provider: originalProvider,
        claude_profile: originalClaudeProfile,
        mock_agent_profile: originalMockAgentProfile,
      },
    }).catch(() => {});
  });
});
