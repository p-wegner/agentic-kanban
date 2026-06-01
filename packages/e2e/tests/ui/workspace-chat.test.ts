import {
  test,
  expect,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from "@playwright/test";
import { join } from "node:path";
import { SERVER_URL } from "../helpers/port.js";

// Resolve the mock agent script path (absolute, forward slashes for Windows)
const MOCK_AGENT_SCRIPT = join(
  process.cwd(),
  "packages/server/src/scripts/mock-agent.ts",
).replace(/\\/g, "/");

// tsx loader path for running TS scripts
const TSX_LOADER = join(
  process.cwd(),
  "packages/server/node_modules/tsx/dist/loader.mjs",
).replace(/\\/g, "/");

function mockAgentCommand(profile: string, delayMs = 100): string {
  return `node --import "file://${TSX_LOADER}" "${MOCK_AGENT_SCRIPT}" --profile ${profile} --delay-ms ${delayMs}`;
}

async function describeResponse(response: APIResponse) {
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "<body unavailable>";
  }

  const trimmedBody = body.length > 500 ? `${body.slice(0, 500)}...` : body;
  return `${response.status()} ${response.statusText()} ${trimmedBody}`;
}

async function expectOkResponse(response: APIResponse, label: string) {
  if (!response.ok()) {
    throw new Error(`${label} failed: ${await describeResponse(response)}`);
  }
}

async function expectJson<T>(response: APIResponse, label: string): Promise<T> {
  await expectOkResponse(response, label);
  return (await response.json()) as T;
}

async function retryApiAction<T>(
  label: string,
  action: () => Promise<T>,
  timeoutMs = 10000,
): Promise<T> {
  let lastError: unknown;
  let result: T | undefined;
  let didSucceed = false;

  try {
    await expect(async () => {
      try {
        result = await action();
        didSucceed = true;
        lastError = undefined;
      } catch (error) {
        lastError = error;
        throw error;
      }
    }).toPass({ timeout: timeoutMs, intervals: [250, 500, 1000] });
  } catch {
    const message =
      lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`${label} failed after retries. Last error: ${message}`);
  }
  if (!didSucceed) {
    throw new Error(`${label} failed after retries with no result`);
  }

  return result as T;
}

test.describe("Workspace Panel Chat Input", () => {
  let projectId: string;
  let statusId: string;
  const createdWorkspaceIds: string[] = [];
  const createdIssueIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
    const projects = await expectJson<Array<{ id: string }>>(
      projectsRes,
      "GET /api/projects",
    );
    expect(projects.length, "E2E server has no registered projects").toBeGreaterThan(
      0,
    );

    const activeProjectRes = await request.get(
      `${SERVER_URL}/api/preferences/active-project`,
    );
    if (activeProjectRes.ok()) {
      const activeProject = await activeProjectRes.json();
      projectId = activeProject.projectId ?? projects[0].id;
    } else {
      projectId = projects[0].id;
    }

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await expectJson<Array<{ id: string; name: string }>>(
      statusesRes,
      "GET project statuses",
    );
    expect(statuses.length, "Project has no statuses").toBeGreaterThan(0);
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todoStatus ? todoStatus.id : statuses[0].id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`).catch(() => {});
    }
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`).catch(() => {});
    }
  });

  async function createWorkspace(
    request: APIRequestContext,
    suffix: string,
  ) {
    const issueTitle = `ChatInputTest ${suffix}`;
    const branchName = `feature/chat-input-${suffix}`;

    const issue = await retryApiAction(`create issue "${issueTitle}"`, async () => {
      const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
        data: { title: issueTitle, statusId, projectId },
      });
      return await expectJson<{ id: string }>(issueRes, "POST /api/issues");
    });
    const issueId = issue.id;
    createdIssueIds.push(issueId);

    const workspace = await retryApiAction(
      `create workspace "${branchName}"`,
      async () => {
        const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
          data: { issueId, branch: branchName },
        });
        return await expectJson<{ id: string }>(
          wsRes,
          "POST /api/workspaces",
        );
      },
    );
    const workspaceId = workspace.id;
    createdWorkspaceIds.push(workspaceId);

    await setupWorkspaceWithRetry(request, workspaceId);

    return { issueTitle, branchName, workspaceId };
  }

  async function openWorkspacePanel(
    page: Page,
    issueTitle: string,
    branchName: string,
  ) {
    const issueCardTitle = page.locator("p", { hasText: issueTitle }).first();
    await expect(
      issueCardTitle,
      `Issue "${issueTitle}" should be visible in the active project board`,
    ).toBeVisible({ timeout: 10000 });
    await issueCardTitle.click();
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();

    const wsLabel = page.locator("label", { hasText: "Workspaces" });
    const wsSection = wsLabel.locator("..");
    const existingWorkspaceButton = wsSection
      .locator("button", { hasText: branchName })
      .or(wsSection.locator("button", { hasText: "View Workspaces" }))
      .first();
    await expect(
      existingWorkspaceButton,
      `Issue "${issueTitle}" should expose existing workspace "${branchName}"`,
    ).toBeVisible({ timeout: 10000 });
    await existingWorkspaceButton.click();

    await expect(page.locator("h2", { hasText: issueTitle })).toBeVisible({
      timeout: 5000,
    });
  }

  function workspacePanel(page: Page, issueTitle: string) {
    return page
      .locator("[data-panel]", {
        has: page.locator("h2", { hasText: issueTitle }),
      })
      .last();
  }

  function workspaceCard(page: Page, issueTitle: string, branchName: string) {
    const panel = workspacePanel(page, issueTitle);
    return panel.locator("div.border.rounded", { hasText: branchName }).first();
  }

  async function ensureWorkspaceChatMounted(
    page: Page,
    issueTitle: string,
    branchName: string,
  ) {
    const panel = workspacePanel(page, issueTitle);
    const card = workspaceCard(page, issueTitle, branchName);
    await expect(card).toBeVisible({ timeout: 15000 });

    const chatSurface = panel
      .locator("textarea")
      .or(panel.locator('button:has-text("Stop")'))
      .or(panel.locator("text=Completed"))
      .first();

    const className = await card.getAttribute("class");
    if (
      !(await chatSurface.isVisible().catch(() => false)) &&
      !className?.includes("bg-blue-50")
    ) {
      await card.click();
    }

    await expect(chatSurface).toBeVisible({ timeout: 10000 });
  }

  async function fillTextarea(page: Page, text: string) {
    await expect(async () => {
      const textarea = page.locator("textarea").first();
      await expect(textarea).toBeVisible({ timeout: 2000 });
      await textarea.fill(text);
    }).toPass({ timeout: 10000, intervals: [250, 500, 1000] });
  }

  async function setupWorkspaceWithRetry(
    request: APIRequestContext,
    workspaceId: string,
    timeoutMs = 10000,
  ) {
    await retryApiAction(
      `setup workspace ${workspaceId}`,
      async () => {
        const setupRes = await request.post(
          `${SERVER_URL}/api/workspaces/${workspaceId}/setup`,
          { data: {} },
        );
        await expectOkResponse(setupRes, "POST workspace setup");
      },
      timeoutMs,
    );

    await expect
      .poll(
        async () => {
          const workspaceRes = await request.get(
            `${SERVER_URL}/api/workspaces/${workspaceId}`,
          );
          if (!workspaceRes.ok()) {
            return `workspace-${await describeResponse(workspaceRes)}`;
          }

          const workspace = await workspaceRes.json();
          return workspace?.workingDir ? "ready" : "missing-working-dir";
        },
        { timeout: timeoutMs, intervals: [250, 500, 1000] },
      )
      .toBe("ready");
  }

  async function waitForWorkspaceStatus(
    request: APIRequestContext,
    workspaceId: string,
    expectedStatus: string,
    timeoutMs = 10000,
  ) {
    await expect
      .poll(
        async () => {
          const workspaceRes = await request.get(
            `${SERVER_URL}/api/workspaces/${workspaceId}`,
          );
          if (!workspaceRes.ok()) return `workspace-${workspaceRes.status()}`;

          const workspace = await workspaceRes.json();
          return workspace?.status ?? "missing-status";
        },
        { timeout: timeoutMs, intervals: [250, 500, 1000] },
      )
      .toBe(expectedStatus);
  }

  async function waitForNoRunningSessions(
    request: APIRequestContext,
    workspaceId: string,
    timeoutMs = 10000,
  ) {
    await expect
      .poll(
        async () => {
          const sessionsRes = await request.get(
            `${SERVER_URL}/api/workspaces/${workspaceId}/sessions`,
          );
          if (!sessionsRes.ok()) return `sessions-${sessionsRes.status()}`;

          const sessions = await sessionsRes.json();
          return sessions.some((s: { status: string }) => s.status === "running")
            ? "running"
            : "idle";
        },
        { timeout: timeoutMs, intervals: [250, 500, 1000] },
      )
      .toBe("idle");
  }

  async function stopWorkspaceAndWaitForIdle(
    request: APIRequestContext,
    workspaceId: string,
  ) {
    const stopRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/stop`,
      { data: {} },
    );
    await expectOkResponse(stopRes, "POST workspace stop");
    await waitForNoRunningSessions(request, workspaceId);
    await waitForWorkspaceStatus(request, workspaceId, "idle");
  }

  async function launchWorkspace(
    request: APIRequestContext,
    workspaceId: string,
    data: Record<string, unknown>,
  ) {
    return await retryApiAction(`launch workspace ${workspaceId}`, async () => {
      const launchRes = await request.post(
        `${SERVER_URL}/api/workspaces/${workspaceId}/launch`,
        { data },
      );
      if (launchRes.status() !== 201) {
        throw new Error(
          `POST workspace launch failed: ${await describeResponse(launchRes)}`,
        );
      }
      return (await launchRes.json()) as { sessionId: string };
    });
  }

  async function waitForSessionStatus(
    request: APIRequestContext,
    workspaceId: string,
    sessionId: string,
    expectedStatus: string,
    timeoutMs = 10000,
  ) {
    await expect
      .poll(
        async () => {
          const sessionsRes = await request.get(
            `${SERVER_URL}/api/workspaces/${workspaceId}/sessions`,
          );
          if (!sessionsRes.ok()) return `sessions-${sessionsRes.status()}`;

          const sessions = await sessionsRes.json();
          const session = sessions.find((s: { id: string }) => s.id === sessionId);
          return session?.status ?? "missing-session";
        },
        { timeout: timeoutMs, intervals: [250, 500, 1000] },
      )
      .toBe(expectedStatus);
  }

  async function waitForSessionNotRunning(
    request: APIRequestContext,
    workspaceId: string,
    sessionId: string,
    timeoutMs = 10000,
  ) {
    await expect
      .poll(
        async () => {
          const sessionsRes = await request.get(
            `${SERVER_URL}/api/workspaces/${workspaceId}/sessions`,
          );
          if (!sessionsRes.ok()) return `sessions-${sessionsRes.status()}`;

          const sessions = await sessionsRes.json();
          const session = sessions.find((s: { id: string }) => s.id === sessionId);
          return session?.status === "completed" || session?.status === "stopped"
            ? "not-running"
            : (session?.status ?? "missing-session");
        },
        { timeout: timeoutMs, intervals: [250, 500, 1000] },
      )
      .toBe("not-running");
  }

  async function waitForSessionExit(
    request: APIRequestContext,
    sessionId: string,
    timeoutMs = 10000,
  ) {
    await expect
      .poll(
        async () => {
          const outputRes = await request.get(
            `${SERVER_URL}/api/sessions/${sessionId}/output`,
          );
          if (!outputRes.ok()) return `output-${outputRes.status()}`;

          const messages = await outputRes.json();
          return messages.some((m: { type: string }) => m.type === "exit")
            ? "exited"
            : "waiting";
        },
        { timeout: timeoutMs, intervals: [250, 500, 1000] },
      )
      .toBe("exited");
  }

  test("chat input visible for idle workspace (no session)", async ({
    page,
    request,
  }) => {
    const suffix = Date.now().toString(36);
    const { issueTitle, branchName, workspaceId } = await createWorkspace(
      request,
      suffix,
    );

    // Stop auto-launched session so workspace is idle
    await stopWorkspaceAndWaitForIdle(request, workspaceId);

    await page.goto("/");
    await page.waitForSelector("h2");

    await openWorkspacePanel(page, issueTitle, branchName);
    await ensureWorkspaceChatMounted(page, issueTitle, branchName);

    // Chat textarea and Send button should be visible in the idle state
    const textarea = page.locator('textarea[placeholder*="Message agent"]').first();
    await expect(textarea).toBeVisible({ timeout: 5000 });

    const sendButton = page.locator('button:has-text("Send")').first();
    await expect(sendButton).toBeVisible();

    // Send button disabled when textarea is empty
    await expect(sendButton).toBeDisabled();
  });

  test("workspace setup failures include API details", async ({ request }) => {
    await expect(
      setupWorkspaceWithRetry(request, "missing-workspace-chat-setup", 1000),
    ).rejects.toThrow(/POST workspace setup failed: 404.*Workspace not found/s);
  });

  test("Stop button appears while agent is processing", async ({
    page,
    request,
  }) => {
    const suffix = `stop-${Date.now().toString(36)}`;
    const { issueTitle, branchName, workspaceId } = await createWorkspace(
      request,
      suffix,
    );

    // Stop auto-launched session
    await stopWorkspaceAndWaitForIdle(request, workspaceId);

    // Launch with a slow standard mock agent to give the UI time to observe the running state
    const { sessionId } = await launchWorkspace(request, workspaceId, {
      prompt: "start task",
      agentCommand: mockAgentCommand("standard", 10000),
    });

    await waitForSessionStatus(request, workspaceId, sessionId, "running");

    await page.goto("/");
    await page.waitForSelector("h2");

    await openWorkspacePanel(page, issueTitle, branchName);
    await ensureWorkspaceChatMounted(page, issueTitle, branchName);

    // While agent is processing, Stop button should appear
    const stopButton = page.locator('button:has-text("Stop")').first();
    await expect(stopButton).toBeVisible({ timeout: 8000 });

    // Textarea should be disabled with "Agent is working..." placeholder
    const textarea = page.locator("textarea").first();
    await expect(textarea).toBeDisabled();
    await expect(textarea).toHaveAttribute(
      "placeholder",
      "Agent is working...",
    );

    // Stop the session to clean up
    await stopButton.click();
  });

  test("Completed indicator appears after agent finishes", async ({
    page,
    request,
  }) => {
    const suffix = `done-${Date.now().toString(36)}`;
    const { issueTitle, branchName, workspaceId } = await createWorkspace(
      request,
      suffix,
    );

    // Stop auto-launched session
    await stopWorkspaceAndWaitForIdle(request, workspaceId);

    // Launch with fast minimal mock agent
    await launchWorkspace(request, workspaceId, {
      prompt: "start task",
      agentCommand: mockAgentCommand("minimal", 50),
    });

    await page.goto("/");
    await page.waitForSelector("h2");

    await openWorkspacePanel(page, issueTitle, branchName);
    await ensureWorkspaceChatMounted(page, issueTitle, branchName);

    // Wait for agent to complete — "Completed" shows in TerminalView result event
    const completed = page.locator("text=Completed").first();
    await expect(completed).toBeVisible({ timeout: 10000 });

    // After completion: chat textarea should be enabled with normal placeholder
    const textarea = page.locator("textarea").first();
    await expect(textarea).toBeEnabled({ timeout: 5000 });
    await expect(textarea).toHaveAttribute("placeholder", /Message agent/);

    // Send button should be visible (not Stop)
    await expect(page.locator('button:has-text("Send")').first()).toBeVisible();
  });

  test("Send button launches agent from idle workspace", async ({
    page,
    request,
  }) => {
    const suffix = `send-${Date.now().toString(36)}`;
    const { issueTitle, branchName, workspaceId } = await createWorkspace(
      request,
      suffix,
    );

    // Stop auto-launched session
    await stopWorkspaceAndWaitForIdle(request, workspaceId);

    await page.goto("/");
    await page.waitForSelector("h2");

    await openWorkspacePanel(page, issueTitle, branchName);
    await ensureWorkspaceChatMounted(page, issueTitle, branchName);

    // Type a message in the chat input
    const textarea = page.locator('textarea[placeholder*="Message agent"]').first();
    await expect(textarea).toBeVisible({ timeout: 5000 });
    await fillTextarea(page, "Test message");

    // Send button should now be enabled
    const sendButton = page.locator('button:has-text("Send")').first();
    await expect(sendButton).toBeEnabled();

    // Click Send — agent launches (Stop button or completion indicator appears)
    await sendButton.click();

    const indicator = page
      .locator('button:has-text("Stop")')
      .or(page.locator("text=Completed").or(page.locator("text=Failed")))
      .first();
    await expect(indicator).toBeVisible({ timeout: 10000 });
  });

  test("Ctrl+Enter sends message from idle workspace", async ({
    page,
    request,
  }) => {
    const suffix = `ctrlenter-${Date.now().toString(36)}`;
    const { issueTitle, branchName, workspaceId } = await createWorkspace(
      request,
      suffix,
    );

    // Stop auto-launched session
    await stopWorkspaceAndWaitForIdle(request, workspaceId);

    await page.goto("/");
    await page.waitForSelector("h2");

    await openWorkspacePanel(page, issueTitle, branchName);
    await ensureWorkspaceChatMounted(page, issueTitle, branchName);

    // Type a message
    const textarea = page.locator('textarea[placeholder*="Message agent"]').first();
    await expect(textarea).toBeVisible({ timeout: 5000 });
    await fillTextarea(page, "Test Ctrl+Enter");

    // Press Ctrl+Enter to send
    await textarea.press("Control+Enter");

    // Agent should launch
    const indicator = page
      .locator('button:has-text("Stop")')
      .or(page.locator("text=Completed").or(page.locator("text=Failed")))
      .first();
    await expect(indicator).toBeVisible({ timeout: 10000 });
  });

  test("UI: send follow-up message after session completes (multi-turn UI flow)", async ({
    page,
    request,
  }) => {
    const suffix = `ui-multiturn-${Date.now().toString(36)}`;
    const { issueTitle, branchName, workspaceId } = await createWorkspace(
      request,
      suffix,
    );

    // Stop auto-launched session
    await stopWorkspaceAndWaitForIdle(request, workspaceId);

    // Launch a fast mock agent so the first session finishes quickly
    await launchWorkspace(request, workspaceId, {
      prompt: "start task",
      agentCommand: mockAgentCommand("minimal", 50),
    });

    await page.goto("/");
    await page.waitForSelector("h2");

    await openWorkspacePanel(page, issueTitle, branchName);
    await ensureWorkspaceChatMounted(page, issueTitle, branchName);

    // Wait for the first session to complete — "Completed" appears in terminal
    await expect(page.locator("text=Completed").first()).toBeVisible({
      timeout: 10000,
    });

    // Textarea should be re-enabled after completion
    const textarea = page.locator('textarea[placeholder*="Message agent"]').first();
    await expect(textarea).toBeEnabled({ timeout: 5000 });

    // Type a follow-up message
    await fillTextarea(page, "Follow-up: what did you do?");

    const sendButton = page.locator('button:has-text("Send")').first();
    await expect(sendButton).toBeEnabled();

    // Send the follow-up — this triggers POST /turn which resumes via --resume
    await sendButton.click();

    // A new agent session should launch — Stop button or new Completed should appear
    const indicator = page
      .locator('button:has-text("Stop")')
      .or(page.locator("text=Completed").nth(1))
      .or(page.locator("text=Resuming session").first())
      .first();
    await expect(indicator).toBeVisible({ timeout: 15000 });
  });

  test("Send follow-up via /turn after agent session completes", async ({
    request,
  }) => {
    const suffix = `followup-${Date.now().toString(36)}`;
    const { workspaceId } = await createWorkspace(request, suffix);

    // Stop auto-launched session
    await stopWorkspaceAndWaitForIdle(request, workspaceId);

    // Launch fast mock agent so it completes quickly
    const { sessionId } = await launchWorkspace(request, workspaceId, {
      prompt: "start task",
      agentCommand: mockAgentCommand("minimal", 50),
    });

    // Wait for agent to complete
    await waitForSessionNotRunning(request, workspaceId, sessionId);
    await waitForSessionExit(request, sessionId);

    // POST /turn — since the agent process exited, it goes through the stale→resume path
    // returning 201 with { sessionId, resumed: true }
    const turnRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/turn`,
      {
        data: { content: "Follow-up question" },
      },
    );

    // 201 = stale resume (new session launched), 200 = turn sent to live stdin
    expect([200, 201]).toContain(turnRes.status());

    if (turnRes.status() === 201) {
      const body = await turnRes.json();
      expect(body).toHaveProperty("sessionId");
      expect(body.resumed).toBe(true);
    } else {
      const body = await turnRes.json();
      expect(body.ok).toBe(true);
    }
  });
});
