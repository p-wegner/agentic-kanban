/**
 * E2E tests for the TodoProgress bar displayed on issue cards.
 *
 * Strategy: enable mock_agent with todo-progress profile before each test.
 * The profile emits a sequence of TodoWrite events that transition tasks through
 * pending → in_progress → completed, letting us verify each UI state.
 */
import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Agent task progress bar on issue cards", () => {
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
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { mock_agent: "false", mock_agent_profile: "" },
    });
  });

  async function enableTodoProgressAgent(
    request: Parameters<Parameters<typeof test>[1]>[0]["request"],
  ) {
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { mock_agent: "true", mock_agent_profile: "todo-progress" },
    });
  }

  async function createIssue(
    title: string,
    request: Parameters<Parameters<typeof test>[1]>[0]["request"],
  ) {
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title, statusId: todoStatusId, projectId, skipAutoReview: true },
    });
    const { id: issueId } = await issueRes.json();
    createdIssueIds.push(issueId);
    return issueId;
  }

  async function createWorkspace(
    issueId: string,
    branchSuffix: string,
    request: Parameters<Parameters<typeof test>[1]>[0]["request"],
  ) {
    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: {
        issueId,
        branch: `feature/task-progress-${branchSuffix}`,
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
        if (latestSession?.id) {
          const outputRes = await request.get(
            `${SERVER_URL}/api/sessions/${latestSession.id}/output`,
          );
          if (outputRes.ok()) {
            const messages = await outputRes.json();
            if (messages.some((m: { type: string }) => m.type === "exit")) return latestSession.id;
          }
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  /** Locate the issue card for a given title and return its root div. */
  function getIssueCard(
    page: Parameters<Parameters<typeof test>[1]>[0]["page"],
    issueTitle: string,
  ) {
    const titleP = page.locator("p", { hasText: issueTitle }).first();
    return titleP.locator("xpath=../..");
  }

  /**
   * Locate the TodoProgress bar within a card.
   * The progress bar track (div.h-1.bg-gray-200) uniquely identifies the TodoProgress
   * component — the workspace status row uses different class combinations.
   */
  function getTodoProgressBar(card: ReturnType<typeof getIssueCard>) {
    return card.locator("div.h-1.bg-gray-200.rounded-full");
  }

  /**
   * Locate the TodoProgress container (the outer div wrapping bar + expand button).
   * Uses :has() to distinguish from the workspace status row which also has mt-1.5 px-1.
   */
  function getTodoProgressContainer(card: ReturnType<typeof getIssueCard>) {
    return card.locator("div.mt-1\\.5.px-1", { has: card.page().locator("div.h-1.bg-gray-200") });
  }

  test("progress bar appears on issue card when agent emits TodoWrite", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);

    await enableTodoProgressAgent(request);

    const suffix = Date.now().toString(36);
    const issueTitle = `Task progress test ${suffix}`;
    const issueId = await createIssue(issueTitle, request);

    await page.goto("/");
    await page.waitForSelector(".board-columns-scroll h2");

    await createWorkspace(issueId, suffix, request);

    const card = getIssueCard(page, issueTitle);
    await expect(card).toBeVisible({ timeout: 15000 });

    // The progress bar track is the clearest indicator that TodoProgress rendered
    const progressBar = getTodoProgressBar(card);
    await expect(progressBar).toBeVisible({ timeout: 30000 });
  });

  test("progress bar shows N/M tasks text and active count badge", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);

    await enableTodoProgressAgent(request);

    const suffix = `cnt-${Date.now().toString(36)}`;
    const issueTitle = `Task progress test ${suffix}`;
    const issueId = await createIssue(issueTitle, request);

    await page.goto("/");
    await page.waitForSelector(".board-columns-scroll h2");

    await createWorkspace(issueId, suffix, request);

    const card = getIssueCard(page, issueTitle);
    await expect(card).toBeVisible({ timeout: 15000 });

    const progressBar = getTodoProgressBar(card);
    await expect(progressBar).toBeVisible({ timeout: 30000 });

    // Tasks text: "X/3 tasks" (total is always 3 in the todo-progress profile)
    const progressContainer = getTodoProgressContainer(card);
    const tasksText = progressContainer.locator("span", { hasText: /\/3 tasks/ });
    await expect(tasksText).toBeVisible({ timeout: 5000 });

    // Active count badge: "N active" (visible when at least one task is in_progress)
    const activeBadge = progressContainer.locator("span", { hasText: /\d+ active/ });
    await expect(activeBadge).toBeVisible({ timeout: 5000 });
  });

  test("colored progress bar segments reflect completion ratio", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);

    await enableTodoProgressAgent(request);

    const suffix = `bar-${Date.now().toString(36)}`;
    const issueTitle = `Task progress test ${suffix}`;
    const issueId = await createIssue(issueTitle, request);

    await page.goto("/");
    await page.waitForSelector(".board-columns-scroll h2");

    await createWorkspace(issueId, suffix, request);

    const card = getIssueCard(page, issueTitle);
    await expect(card).toBeVisible({ timeout: 15000 });

    const progressBar = getTodoProgressBar(card);
    await expect(progressBar).toBeVisible({ timeout: 30000 });

    // Wait for at least one completed task (green segment should have non-zero width)
    const greenBar = progressBar.locator("div.bg-green-500");
    await expect(greenBar).toBeVisible({ timeout: 30000 });

    // Green bar width should be > 0 once a task completes
    await expect(async () => {
      const width = await greenBar.evaluate((el) =>
        parseFloat((el as HTMLElement).style.width),
      );
      expect(width).toBeGreaterThan(0);
    }).toPass({ timeout: 15000 });
  });

  test("expanded task list shows individual task items after clicking chevron", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);

    await enableTodoProgressAgent(request);

    const suffix = `exp-${Date.now().toString(36)}`;
    const issueTitle = `Task progress test ${suffix}`;
    const issueId = await createIssue(issueTitle, request);

    await page.goto("/");
    await page.waitForSelector(".board-columns-scroll h2");

    await createWorkspace(issueId, suffix, request);

    const card = getIssueCard(page, issueTitle);
    await expect(card).toBeVisible({ timeout: 15000 });

    const progressContainer = getTodoProgressContainer(card);
    await expect(progressContainer).toBeVisible({ timeout: 30000 });

    // Click the expand/collapse button inside the progress container
    const expandBtn = progressContainer.locator("button").first();
    await expandBtn.click();

    // Expanded list: div.mt-1.ml-3
    const expandedList = progressContainer.locator("div.mt-1.ml-3");
    await expect(expandedList).toBeVisible({ timeout: 5000 });

    // Should show 3 task items
    const taskItems = expandedList.locator("div.flex.items-start");
    await expect(taskItems).toHaveCount(3, { timeout: 5000 });
  });

  test("progress bar disappears after session ends and all tasks complete", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);

    await enableTodoProgressAgent(request);

    const suffix = `end-${Date.now().toString(36)}`;
    const issueTitle = `Task progress test ${suffix}`;
    const issueId = await createIssue(issueTitle, request);

    await createWorkspace(issueId, suffix, request);

    // Wait for mock agent session to finish before loading the board
    const workspaceId = createdWorkspaceIds[createdWorkspaceIds.length - 1];
    const sessionId = await waitForSessionExit(request, workspaceId);
    expect(sessionId).not.toBeNull();

    await page.goto("/");
    await page.waitForSelector(".board-columns-scroll h2");

    const card = getIssueCard(page, issueTitle);
    await expect(card).toBeVisible({ timeout: 10000 });

    // After session exit, the server broadcasts empty todos.
    // When the page loads fresh (no WebSocket history), sessionTodos is empty,
    // so the progress bar track div should not be rendered.
    const progressBar = getTodoProgressBar(card);
    await expect(progressBar).toHaveCount(0);
  });
});
