/**
 * E2E tests for live session stats displayed on issue cards.
 *
 * Strategy: enable mock_agent preference before each test so workspace auto-launch
 * uses the mock agent. The page is loaded first, then the session launch is triggered,
 * and the board receives live stats via WebSocket in real-time.
 */
import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Live session stats on issue cards", () => {
  let projectId: string;
  let todoStatusId: string;
  const createdIssueIds: string[] = [];
  const createdWorkspaceIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
    const projects = await projectsRes.json();
    projectId = projects[0].id;

    await request.put(`${SERVER_URL}/api/preferences/active-project`, {
      data: { projectId },
    });

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    todoStatusId = statuses.find((s: { name: string }) => s.name === "Todo").id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`);
    }
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
    // Restore mock_agent settings
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { mock_agent: "false", mock_agent_delay_ms: "" },
    });
  });

  /** Enable mock agent with a long per-event delay so the session stays active long enough
   *  for live-stats badges to appear on the board before the agent exits. */
  async function enableMockAgent(request: Parameters<Parameters<typeof test>[1]>[0]["request"], delayMs = 60000) {
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { mock_agent: "true", mock_agent_delay_ms: String(delayMs) },
    });
  }

  /** Enable mock agent with no extra delay — for tests that wait for session exit. */
  async function enableMockAgentFast(request: Parameters<Parameters<typeof test>[1]>[0]["request"]) {
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { mock_agent: "true", mock_agent_delay_ms: "" },
    });
  }

  /** Create an issue (no workspace yet). */
  async function createIssue(
    title: string,
    request: Parameters<Parameters<typeof test>[1]>[0]["request"],
  ) {
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title,
        statusId: todoStatusId,
        projectId,
        skipAutoReview: true,
      },
    });
    const { id: issueId } = await issueRes.json();
    createdIssueIds.push(issueId);
    return issueId;
  }

  /** Create a workspace which auto-launches the mock agent (mock_agent must be enabled). */
  async function createWorkspace(
    issueId: string,
    branchSuffix: string,
    request: Parameters<Parameters<typeof test>[1]>[0]["request"],
  ) {
    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: {
        issueId,
        branch: `feature/session-stats-${branchSuffix}`,
        requiresReview: false,
      },
    });
    expect(wsRes.status()).toBe(201);
    const workspaceId = (await wsRes.json()).id;
    createdWorkspaceIds.push(workspaceId);
    return workspaceId;
  }

  async function waitForSessionExit(
    request: Parameters<Parameters<typeof test>[1]>[0]["request"],
    workspaceId: string,
    timeoutMs = 30000,
  ) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const sessionsRes = await request.get(
        `${SERVER_URL}/api/workspaces/${workspaceId}/sessions`,
      );
      if (sessionsRes.ok()) {
        const sessions = await sessionsRes.json();
        const latestSession = sessions[sessions.length - 1];
        if (latestSession && latestSession.id) {
          const outputRes = await request.get(
            `${SERVER_URL}/api/sessions/${latestSession.id}/output`,
          );
          if (outputRes.ok()) {
            const messages = await outputRes.json();
            if (messages.some((m: any) => m.type === "exit")) return latestSession.id;
          }
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  test("model name badge appears on issue card when session is running", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);

    await enableMockAgent(request);

    const suffix = Date.now().toString(36);
    const issueTitle = `Session stats test ${suffix}`;
    const issueId = await createIssue(issueTitle, request);

    // Navigate to board first — board is open before the session starts
    await page.goto("/");
    await page.waitForSelector(".board-columns-scroll h2");

    // Now create workspace → auto-launches mock agent → WS events reach the open page
    await createWorkspace(issueId, suffix, request);

    // The mock agent (standard profile, 500ms delay) emits:
    //   system/init (no model from this)
    //   assistant message with model + usage → triggers session_stats WS event
    //   tool_use → triggers session_activity WS event (sets liveActivity)
    // Both arrive within ~1-2 seconds after launch.

    const issueCardP = page.locator("p", { hasText: issueTitle }).first();
    await expect(issueCardP).toBeVisible({ timeout: 15000 });

    // The stats row uses "mt-0.5" class (unique within the card) containing the model span
    const cardDiv = issueCardP.locator("xpath=../..");
    const statsRow = cardDiv.locator("div.mt-0\\.5");
    const modelBadge = statsRow.locator("span.font-mono").first();

    await expect(modelBadge).toBeVisible({ timeout: 30000 });
    await expect(modelBadge).toHaveText("mock-claude-opus-4");
  });

  test("context token badge appears on issue card during active session", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);

    await enableMockAgent(request);

    const suffix = `ctx-${Date.now().toString(36)}`;
    const issueTitle = `Session stats test ${suffix}`;
    const issueId = await createIssue(issueTitle, request);

    await page.goto("/");
    await page.waitForSelector(".board-columns-scroll h2");

    await createWorkspace(issueId, suffix, request);

    const issueCardP = page.locator("p", { hasText: issueTitle }).first();
    await expect(issueCardP).toBeVisible({ timeout: 15000 });

    const cardDiv = issueCardP.locator("xpath=../..");
    const statsRow = cardDiv.locator("div.mt-0\\.5");

    // Context tokens badge: mock agent usage = {input_tokens: 150} → 0k ctx rounded
    // We match any "Xk ctx" pattern since rounding may vary
    const ctxBadge = statsRow.locator("span", { hasText: /\dk ctx/ }).first();
    await expect(ctxBadge).toBeVisible({ timeout: 30000 });
  });

  test("session stats badges disappear after session ends", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);

    await enableMockAgentFast(request);

    const suffix = `end-${Date.now().toString(36)}`;
    const issueTitle = `Session stats test ${suffix}`;
    const issueId = await createIssue(issueTitle, request);

    await createWorkspace(issueId, suffix, request);

    // Wait for the mock agent session to complete before loading the board
    const workspaceId = createdWorkspaceIds[createdWorkspaceIds.length - 1];
    const sessionId = await waitForSessionExit(request, workspaceId);
    expect(sessionId).not.toBeNull();

    await page.goto("/");
    await page.waitForSelector(".board-columns-scroll h2");

    const issueCardP = page.locator("p", { hasText: issueTitle }).first();
    await expect(issueCardP).toBeVisible({ timeout: 5000 });

    const cardDiv = issueCardP.locator("xpath=../..");

    // After session ends, liveActivity is cleared → stats row is not rendered
    const statsRow = cardDiv.locator("div.mt-0\\.5");
    await expect(statsRow).toHaveCount(0);
  });
});
