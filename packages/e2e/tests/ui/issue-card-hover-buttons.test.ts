import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Issue card hover quick-start buttons", () => {
  let projectId: string;
  let statusId: string;
  const createdIssueIds: string[] = [];
  const createdWorkspaceIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    // Use the currently active project so board shows our test issues
    const activeRes = await request.get(`${SERVER_URL}/api/preferences/active-project`);
    const { projectId: activeId } = await activeRes.json();
    projectId = activeId;

    if (!projectId) {
      const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
      const projects = await projectsRes.json();
      projectId = projects[0].id;
      await request.put(`${SERVER_URL}/api/preferences/active-project`, {
        data: { projectId },
      });
    }

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todoStatus ? todoStatus.id : statuses[0].id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`);
    }
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  test("hovering card with no workspace shows Start Workspace button", async ({
    page,
    request,
  }) => {
    const suffix = Date.now().toString(36);
    const title = `HoverStart ${suffix}`;

    const createRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title, statusId, projectId, priority: "medium" },
    });
    const { id } = await createRes.json();
    createdIssueIds.push(id);

    await page.goto("/");
    await page.waitForSelector("h2");

    // The card is a div[draggable] containing the issue title paragraph
    const card = page.locator("div[draggable]", { has: page.locator("p", { hasText: title }) }).first();
    await expect(card).toBeVisible({ timeout: 10000 });
    await card.hover();

    const btn = card.locator("button", { hasText: "Start Workspace" });
    await expect(btn).toBeVisible({ timeout: 5000 });
  });

  test("clicking Start Workspace button opens workspace creation form", async ({
    page,
    request,
  }) => {
    const suffix = Date.now().toString(36);
    const title = `HoverStartClick ${suffix}`;

    const createRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title, statusId, projectId, priority: "medium" },
    });
    const { id } = await createRes.json();
    createdIssueIds.push(id);

    await page.goto("/");
    await page.waitForSelector("h2");

    const card = page.locator("div[draggable]", { has: page.locator("p", { hasText: title }) }).first();
    await expect(card).toBeVisible({ timeout: 10000 });
    await card.hover();

    const btn = card.locator("button", { hasText: "Start Workspace" });
    await expect(btn).toBeVisible({ timeout: 5000 });
    await btn.click();

    // WorkspacePanel with CreateWorkspaceForm should open — branch name field is present
    await expect(
      page.locator("input[placeholder*='ranch']").first(),
    ).toBeVisible({ timeout: 5000 });
  });

  test("hovering card with idle workspace shows Resume button", async ({
    page,
    request,
  }) => {
    const suffix = Date.now().toString(36);
    const title = `HoverResume ${suffix}`;

    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title, statusId, projectId, priority: "medium" },
    });
    const { id: issueId } = await issueRes.json();
    createdIssueIds.push(issueId);

    // Create workspace then PATCH it to idle (worktree creation may fail but DB record is created)
    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: {
        issueId,
        branch: `feature/hover-resume-${suffix}`,
      },
    });
    const ws = await wsRes.json();
    const workspaceId = ws.id;
    createdWorkspaceIds.push(workspaceId);

    await request.patch(`${SERVER_URL}/api/workspaces/${workspaceId}`, {
      data: { status: "idle" },
    });

    await page.goto("/");
    await page.waitForSelector("h2");

    const card = page.locator("div[draggable]", { has: page.locator("p", { hasText: title }) }).first();
    await expect(card).toBeVisible({ timeout: 10000 });
    await card.hover();

    const btn = card.locator("button", { hasText: "Resume" });
    await expect(btn).toBeVisible({ timeout: 5000 });
  });
});
