import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("AI Code Review Flow", () => {
  let projectId: string;
  let todoStatusId: string;
  const createdWorkspaceIds: string[] = [];
  const createdIssueIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    // Use the active project (set by global-setup to the worktree's registered project)
    const activePrefRes = await request.get(`${SERVER_URL}/api/preferences/active-project`);
    const activePref = await activePrefRes.json();
    projectId = activePref.projectId;

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    todoStatusId = todoStatus ? todoStatus.id : statuses[0].id;

    // Enable mock profile and disable auto_review/auto_merge so workspaces reach "idle"
    // after the agent exits. Without this, the workflow goes active→reviewing→closed
    // and tests waiting for "idle" would time out.
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { claude_profile: "mock", auto_review: "false", auto_merge: "false" },
    });
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`);
    }
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { claude_profile: "", auto_review: "true", auto_merge: "true" },
    });
  });

  async function createIssueAndWorkspace(
    request: import("@playwright/test").APIRequestContext,
    titlePrefix: string,
  ) {
    const suffix = Date.now().toString(36);
    const issueTitle = `${titlePrefix} ${suffix}`;
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: issueTitle, statusId: todoStatusId, projectId },
    });
    const issue = await issueRes.json();
    createdIssueIds.push(issue.id);

    const branchName = `feature/cr-${suffix}`;
    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId: issue.id, branch: branchName },
    });
    const workspace = await wsRes.json();
    createdWorkspaceIds.push(workspace.id);

    return { issueTitle, branchName, workspaceId: workspace.id as string };
  }

  async function waitForWorkspaceStatus(
    request: import("@playwright/test").APIRequestContext,
    workspaceId: string,
    status: string,
    timeoutMs = 15000,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await request.get(`${SERVER_URL}/api/workspaces/${workspaceId}`);
      if (res.ok()) {
        const ws = await res.json();
        if (ws?.status === status) return ws;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Workspace ${workspaceId} did not reach status "${status}" within ${timeoutMs}ms`);
  }

  test("Review API returns 200 and sessionId for idle workspace", async ({ request }) => {
    const { workspaceId } = await createIssueAndWorkspace(request, "ReviewAPI");

    // Wait for the auto-launched agent to finish so workspace becomes idle
    await waitForWorkspaceStatus(request, workspaceId, "idle");

    const reviewRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/review`,
    );
    expect(reviewRes.status()).toBe(200);
    const body = await reviewRes.json();
    expect(body.sessionId).toBeTruthy();
  });

  test("Workspace transitions reviewing → idle after mock review session", async ({ request }) => {
    const { workspaceId } = await createIssueAndWorkspace(request, "ReviewTransition");

    await waitForWorkspaceStatus(request, workspaceId, "idle");

    // Trigger review
    const reviewRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/review`,
    );
    expect(reviewRes.status()).toBe(200);
    const { sessionId } = await reviewRes.json();

    // Workspace should immediately be "reviewing"
    await waitForWorkspaceStatus(request, workspaceId, "reviewing", 5000);

    // Wait for mock session to emit exit event
    const sessionDone = await (async () => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const outputRes = await request.get(`${SERVER_URL}/api/sessions/${sessionId}/output`);
        if (outputRes.status() === 200) {
          const messages = await outputRes.json();
          if (messages.some((m: { type: string }) => m.type === "exit")) return true;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    })();
    expect(sessionDone).toBe(true);

    // After review session exits, workspace returns to idle
    await waitForWorkspaceStatus(request, workspaceId, "idle");
  });

  test("Review endpoint returns 409 when workspace is not idle", async ({ request }) => {
    const suffix = Date.now().toString(36);
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `ReviewBusy ${suffix}`, statusId: todoStatusId, projectId },
    });
    const issue = await issueRes.json();
    createdIssueIds.push(issue.id);

    // Create workspace (auto-launches agent — workspace is "active")
    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId: issue.id, branch: `feature/cr-busy-${suffix}` },
    });
    const workspace = await wsRes.json();
    createdWorkspaceIds.push(workspace.id);

    // Immediately try to review while agent is still running (should be active, not idle)
    const wsRes2 = await request.get(`${SERVER_URL}/api/workspaces/${workspace.id}`);
    const ws = await wsRes2.json();

    if (ws?.status !== "idle") {
      const reviewRes = await request.post(
        `${SERVER_URL}/api/workspaces/${workspace.id}/review`,
      );
      expect(reviewRes.status()).toBe(409);
    } else {
      // If agent already exited (very fast), skip the 409 assertion
      test.info().annotations.push({ type: "note", description: "Agent exited before 409 check — skipping" });
    }
  });

  test("Review button is visible in workspace panel for idle workspace", async ({ page, request }) => {
    const { issueTitle, branchName, workspaceId } = await createIssueAndWorkspace(
      request,
      "ReviewBtn",
    );

    // Wait for the auto-launched agent to finish
    await waitForWorkspaceStatus(request, workspaceId, "idle");

    await page.goto("/");
    await page.waitForSelector("h2");

    // Open issue detail panel
    await page.locator("p", { hasText: issueTitle }).first().click();
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();

    // Click into the workspace from the Workspaces section
    const wsLabel = page.locator("label", { hasText: "Workspaces" });
    const wsSection = wsLabel.locator("..");
    await wsSection.locator("button").first().click();

    await expect(page.locator("h2", { hasText: "Workspaces —" })).toBeVisible({ timeout: 5000 });

    // Dismiss backdrop if present
    const backdrop = page.locator("div.fixed.inset-0.bg-black\\/30").first();
    if (await backdrop.isVisible()) {
      await backdrop.click({ force: true });
      await page.waitForTimeout(300);
    }

    // Expand the workspace row by clicking the branch name
    await page.locator(`text=${branchName}`).first().click({ force: true });

    // Review button should be visible and enabled (scoped to workspace panel to avoid "In Review" column button)
    const wsPanel = page.locator("section, div").filter({ has: page.locator("h2", { hasText: "Workspaces —" }) }).first();
    const reviewBtn = wsPanel.locator('button', { hasText: /^Review$/ }).first();
    await expect(reviewBtn).toBeVisible({ timeout: 5000 });
    await expect(reviewBtn).toBeEnabled();
  });

  test("Clicking Review shows reviewing status in workspace panel", async ({ page, request }) => {
    const { issueTitle, branchName, workspaceId } = await createIssueAndWorkspace(
      request,
      "ReviewClick",
    );

    await waitForWorkspaceStatus(request, workspaceId, "idle");

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.locator("p", { hasText: issueTitle }).first().click();
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();

    const wsLabel = page.locator("label", { hasText: "Workspaces" });
    const wsSection = wsLabel.locator("..");
    await wsSection.locator("button").first().click();
    await expect(page.locator("h2", { hasText: "Workspaces —" })).toBeVisible({ timeout: 5000 });

    const backdrop = page.locator("div.fixed.inset-0.bg-black\\/30").first();
    if (await backdrop.isVisible()) {
      await backdrop.click({ force: true });
      await page.waitForTimeout(300);
    }

    await page.locator(`text=${branchName}`).first().click({ force: true });

    // Scope to workspace panel to avoid matching "In Review" column navigation button
    const wsPanel2 = page.locator("section, div").filter({ has: page.locator("h2", { hasText: "Workspaces —" }) }).first();
    await wsPanel2.locator('button', { hasText: /^Review$/ }).first().click();

    // Workspace status badge transitions to "reviewing"
    await expect(page.locator("span", { hasText: "reviewing" })).toBeVisible({ timeout: 10000 });
  });

  test("auto_review preference persists and is readable", async ({ request }) => {
    // Verify that auto_review can be toggled via the preferences API
    const setFalse = await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { auto_review: "false" },
    });
    expect(setFalse.status()).toBe(200);

    const readFalse = await request.get(`${SERVER_URL}/api/preferences/settings`);
    const settingsFalse = await readFalse.json();
    expect(settingsFalse.auto_review).toBe("false");

    const setTrue = await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { auto_review: "true" },
    });
    expect(setTrue.status()).toBe(200);

    const readTrue = await request.get(`${SERVER_URL}/api/preferences/settings`);
    const settingsTrue = await readTrue.json();
    expect(settingsTrue.auto_review).toBe("true");

    // Restore to "false" so subsequent tests in this suite can safely wait for "idle"
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { auto_review: "false" },
    });
  });

  test("review_auto_fix preference persists and is readable", async ({ request }) => {
    const setFalse = await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { review_auto_fix: "false" },
    });
    expect(setFalse.status()).toBe(200);

    const read = await request.get(`${SERVER_URL}/api/preferences/settings`);
    const settings = await read.json();
    expect(settings.review_auto_fix).toBe("false");

    // Restore default
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { review_auto_fix: "true" },
    });
  });

  test("AI Reviewing badge appears on issue card while review session runs", async ({ page, request }) => {
    const { workspaceId } = await createIssueAndWorkspace(request, "ReviewBadge");

    await waitForWorkspaceStatus(request, workspaceId, "idle");

    // Trigger review via API before loading the board
    const reviewRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/review`,
    );
    expect(reviewRes.status()).toBe(200);

    await page.goto("/");
    await page.waitForSelector("h2");

    // IssueCard shows "AI Reviewing" badge with animated pulse dot when status is reviewing
    await expect(page.locator("text=AI Reviewing")).toBeVisible({ timeout: 10000 });
  });
});
