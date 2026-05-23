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

    // Use mock agent so workspace creation doesn't launch a real Claude process
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { mock_agent: "true", auto_review: "false", auto_merge: "false" },
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
      data: { mock_agent: "false", auto_review: "true", auto_merge: "true" },
    });
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

    // WorkspacePanel should open — its header h2 shows the issue title
    await expect(
      page.locator("h2", { hasText: title }),
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

    // Create workspace — mock agent is active so it exits quickly, leaving status="idle"
    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: {
        issueId,
        branch: `feature/hover-resume-${suffix}`,
      },
    });
    const ws = await wsRes.json();
    const workspaceId = ws.id;
    createdWorkspaceIds.push(workspaceId);

    // Wait for mock agent to finish and workspace to reach idle
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const res = await request.get(`${SERVER_URL}/api/workspaces/${workspaceId}`);
      if (res.ok()) {
        const w = await res.json();
        if (w?.status === "idle") break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const card = page.locator("div[draggable]", { has: page.locator("p", { hasText: title }) }).first();
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.hover();

    const btn = card.locator("button", { hasText: "Resume" });
    await expect(btn).toBeVisible({ timeout: 5000 });
  });
});
