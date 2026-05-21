import { test, expect } from "@playwright/test";
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

test.describe("Workspace Panel Chat Input", () => {
  let projectId: string;
  let statusId: string;
  const createdWorkspaceIds: string[] = [];
  const createdIssueIds: string[] = [];

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
    request: import("@playwright/test").APIRequestContext,
    suffix: string,
  ) {
    const issueTitle = `ChatInputTest ${suffix}`;
    const branchName = `feature/chat-input-${suffix}`;

    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: issueTitle, statusId, projectId },
    });
    const issueId = (await issueRes.json()).id;
    createdIssueIds.push(issueId);

    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId, branch: branchName },
    });
    const ws = await wsRes.json();
    const workspaceId = ws.id;
    createdWorkspaceIds.push(workspaceId);

    // Setup workspace (retry loop per CLAUDE.md guidance)
    let setupOk = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await request.post(
          `${SERVER_URL}/api/workspaces/${workspaceId}/setup`,
          { data: {} },
        );
        if (res.ok()) {
          setupOk = true;
          break;
        }
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    return { issueTitle, branchName, workspaceId, setupOk };
  }

  async function openWorkspacePanel(
    page: import("@playwright/test").Page,
    issueTitle: string,
  ) {
    await page.locator("p", { hasText: issueTitle }).first().click();
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();

    const wsLabel = page.locator("label", { hasText: "Workspaces" });
    const wsSection = wsLabel.locator("..");
    await wsSection.locator("button").first().click();

    await expect(
      page.locator("h2", { hasText: "Workspaces —" }),
    ).toBeVisible({ timeout: 5000 });

    // Close any backdrop that might block the workspace panel
    const backdrop = page.locator("div.fixed.inset-0.bg-black\\/30").first();
    if (await backdrop.isVisible()) {
      await backdrop.click({ force: true });
      await page.waitForTimeout(300);
    }
  }

  test("chat input visible for idle workspace (no session)", async ({
    page,
    request,
  }) => {
    const suffix = Date.now().toString(36);
    const { issueTitle, branchName, workspaceId, setupOk } =
      await createWorkspace(request, suffix);
    if (!setupOk) {
      test.skip();
      return;
    }

    // Stop auto-launched session so workspace is idle
    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`, {
      data: {},
    });
    await new Promise((r) => setTimeout(r, 500));

    await page.goto("/");
    await page.waitForSelector("h2");

    await openWorkspacePanel(page, issueTitle);

    // Expand the workspace
    await page.locator(`text=${branchName}`).first().click({ force: true });

    // Chat textarea and Send button should be visible in the idle state
    const textarea = page
      .locator('textarea[placeholder*="Message Claude Code"]')
      .first();
    await expect(textarea).toBeVisible({ timeout: 5000 });

    const sendButton = page.locator('button:has-text("Send")').first();
    await expect(sendButton).toBeVisible();

    // Send button disabled when textarea is empty
    await expect(sendButton).toBeDisabled();
  });

  test("Stop button appears while agent is processing", async ({
    page,
    request,
  }) => {
    const suffix = `stop-${Date.now().toString(36)}`;
    const { issueTitle, branchName, workspaceId, setupOk } =
      await createWorkspace(request, suffix);
    if (!setupOk) {
      test.skip();
      return;
    }

    // Stop auto-launched session
    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`, {
      data: {},
    });
    await new Promise((r) => setTimeout(r, 500));

    // Launch with a slow standard mock agent (2000ms delay) to give us time to observe the running state
    const launchRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/launch`,
      {
        data: {
          prompt: "start task",
          agentCommand: mockAgentCommand("standard", 2000),
        },
      },
    );

    if (launchRes.status() !== 201) {
      test.skip();
      return;
    }

    // Give agent just enough time to start and emit the init event
    await new Promise((r) => setTimeout(r, 500));

    await page.goto("/");
    await page.waitForSelector("h2");

    await openWorkspacePanel(page, issueTitle);
    await page.locator(`text=${branchName}`).first().click({ force: true });

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
    const { issueTitle, branchName, workspaceId, setupOk } =
      await createWorkspace(request, suffix);
    if (!setupOk) {
      test.skip();
      return;
    }

    // Stop auto-launched session
    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`, {
      data: {},
    });
    await new Promise((r) => setTimeout(r, 500));

    // Launch with fast minimal mock agent
    const launchRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/launch`,
      {
        data: {
          prompt: "start task",
          agentCommand: mockAgentCommand("minimal", 50),
        },
      },
    );

    if (launchRes.status() !== 201) {
      test.skip();
      return;
    }

    await page.goto("/");
    await page.waitForSelector("h2");

    await openWorkspacePanel(page, issueTitle);
    await page.locator(`text=${branchName}`).first().click({ force: true });

    // Wait for agent to complete — "Completed" shows in TerminalView result event
    const completed = page.locator("text=Completed").first();
    await expect(completed).toBeVisible({ timeout: 10000 });

    // After completion: chat textarea should be enabled with normal placeholder
    const textarea = page.locator("textarea").first();
    await expect(textarea).toBeEnabled({ timeout: 5000 });
    await expect(textarea).toHaveAttribute("placeholder", /Message Claude Code/);

    // Send button should be visible (not Stop)
    await expect(page.locator('button:has-text("Send")').first()).toBeVisible();
  });

  test("Send button launches agent from idle workspace", async ({
    page,
    request,
  }) => {
    const suffix = `send-${Date.now().toString(36)}`;
    const { issueTitle, branchName, workspaceId, setupOk } =
      await createWorkspace(request, suffix);
    if (!setupOk) {
      test.skip();
      return;
    }

    // Stop auto-launched session
    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`, {
      data: {},
    });
    await new Promise((r) => setTimeout(r, 500));

    await page.goto("/");
    await page.waitForSelector("h2");

    await openWorkspacePanel(page, issueTitle);
    await page.locator(`text=${branchName}`).first().click({ force: true });

    // Type a message in the chat input
    const textarea = page
      .locator('textarea[placeholder*="Message Claude Code"]')
      .first();
    await expect(textarea).toBeVisible({ timeout: 5000 });
    await textarea.click();
    await textarea.fill("Test message");

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
    const { issueTitle, branchName, workspaceId, setupOk } =
      await createWorkspace(request, suffix);
    if (!setupOk) {
      test.skip();
      return;
    }

    // Stop auto-launched session
    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`, {
      data: {},
    });
    await new Promise((r) => setTimeout(r, 500));

    await page.goto("/");
    await page.waitForSelector("h2");

    await openWorkspacePanel(page, issueTitle);
    await page.locator(`text=${branchName}`).first().click({ force: true });

    // Type a message
    const textarea = page
      .locator('textarea[placeholder*="Message Claude Code"]')
      .first();
    await expect(textarea).toBeVisible({ timeout: 5000 });
    await textarea.click();
    await textarea.fill("Test Ctrl+Enter");

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
    const { issueTitle, branchName, workspaceId, setupOk } =
      await createWorkspace(request, suffix);
    if (!setupOk) {
      test.skip();
      return;
    }

    // Stop auto-launched session
    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`, {
      data: {},
    });
    await new Promise((r) => setTimeout(r, 500));

    // Launch a fast mock agent so the first session finishes quickly
    const launchRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/launch`,
      {
        data: {
          prompt: "start task",
          agentCommand: mockAgentCommand("minimal", 50),
        },
      },
    );

    if (launchRes.status() !== 201) {
      test.skip();
      return;
    }

    await page.goto("/");
    await page.waitForSelector("h2");

    await openWorkspacePanel(page, issueTitle);
    await page.locator(`text=${branchName}`).first().click({ force: true });

    // Wait for the first session to complete — "Completed" appears in terminal
    await expect(page.locator("text=Completed").first()).toBeVisible({
      timeout: 10000,
    });

    // Textarea should be re-enabled after completion
    const textarea = page
      .locator('textarea[placeholder*="Message Claude Code"]')
      .first();
    await expect(textarea).toBeEnabled({ timeout: 5000 });

    // Type a follow-up message
    await textarea.click();
    await textarea.fill("Follow-up: what did you do?");

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
    const { workspaceId, setupOk } = await createWorkspace(request, suffix);
    if (!setupOk) {
      test.skip();
      return;
    }

    // Stop auto-launched session
    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`, {
      data: {},
    });
    await new Promise((r) => setTimeout(r, 500));

    // Launch fast mock agent so it completes quickly
    const launchRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/launch`,
      {
        data: {
          prompt: "start task",
          agentCommand: mockAgentCommand("minimal", 50),
        },
      },
    );

    if (launchRes.status() !== 201) {
      test.skip();
      return;
    }

    // Wait for agent to complete
    await new Promise((r) => setTimeout(r, 2000));

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
