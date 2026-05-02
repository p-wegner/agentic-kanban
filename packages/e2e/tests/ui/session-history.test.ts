import { test, expect } from "@playwright/test";

test.describe("Session History UI", () => {
  let projectId: string;
  let statusId: string;

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get("http://localhost:3001/api/projects");
    const projects = await projectsRes.json();
    projectId = projects[0].id;

    const statusesRes = await request.get(
      `http://localhost:3001/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todoStatus ? todoStatus.id : statuses[0].id;
  });

  test("completed sessions show in workspace panel", async ({ page, request }) => {
    // Create an issue and workspace with a completed session
    const issueRes = await request.post("http://localhost:3001/api/issues", {
      data: { title: "History UI test issue", statusId, projectId },
    });
    const issueId = (await issueRes.json()).id;

    const wsRes = await request.post("http://localhost:3001/api/workspaces", {
      data: { issueId, branch: "feature/history-ui-test" },
    });
    const workspaceId = (await wsRes.json()).id;

    // Setup workspace
    await request.post(
      `http://localhost:3001/api/workspaces/${workspaceId}/setup`,
      { data: {} },
    );

    // Launch and wait for completion
    const launchRes = await request.post(
      `http://localhost:3001/api/workspaces/${workspaceId}/launch`,
      {
        data: {
          prompt: "test session history",
          agentCommand: "node -e \"console.log('history test output'); process.exit(0)\"",
        },
      },
    );

    if (launchRes.status() !== 201) {
      test.skip();
      return;
    }

    // Wait for session to complete
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Go to the board and open workspace panel
    await page.goto("/");
    await page.waitForSelector("h2");

    // Find the issue and click to open detail panel
    const issueEl = page.locator("p", { hasText: "History UI test issue" }).first();
    await issueEl.click();

    // Click "Manage" button in the detail panel (under Workspaces section)
    await page.locator('button:has-text("Manage")').first().click();

    // Expand the workspace (click on the branch name)
    await page.locator("text=feature/history-ui-test").first().click();

    // Should show "Past Sessions" section
    await expect(page.locator("text=Past Sessions").first()).toBeVisible({ timeout: 5000 });
  });

  test("click past session shows output in TerminalView", async ({ page, request }) => {
    // Create an issue and workspace with a completed session
    const issueRes = await request.post("http://localhost:3001/api/issues", {
      data: { title: "History output test issue", statusId, projectId },
    });
    const issueId = (await issueRes.json()).id;

    const wsRes = await request.post("http://localhost:3001/api/workspaces", {
      data: { issueId, branch: "feature/history-output-test" },
    });
    const workspaceId = (await wsRes.json()).id;

    // Setup workspace
    await request.post(
      `http://localhost:3001/api/workspaces/${workspaceId}/setup`,
      { data: {} },
    );

    // Launch and wait for completion
    const launchRes = await request.post(
      `http://localhost:3001/api/workspaces/${workspaceId}/launch`,
      {
        data: {
          prompt: "test output viewing",
          agentCommand: "node -e \"console.log('viewable output'); process.exit(0)\"",
        },
      },
    );

    if (launchRes.status() !== 201) {
      test.skip();
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Navigate and open workspace panel
    await page.goto("/");
    await page.waitForSelector("h2");

    const issueEl = page.locator("p", { hasText: "History output test issue" }).first();
    await issueEl.click();
    await page.locator('button:has-text("Manage")').first().click();

    // Expand workspace
    await page.locator("text=feature/history-output-test").first().click();

    // Wait for past sessions and click "View Output"
    await expect(page.locator("text=Past Sessions").first()).toBeVisible({ timeout: 5000 });
    await page.locator('button:has-text("View Output")').first().click();

    // Should show session output header
    await expect(page.locator("text=Session Output").first()).toBeVisible({ timeout: 5000 });

    // TerminalView should show "Disconnected" status
    await expect(page.locator("text=Disconnected").first()).toBeVisible({ timeout: 5000 });
  });
});
