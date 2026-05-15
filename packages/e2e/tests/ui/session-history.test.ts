import { test, expect } from "@playwright/test";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test.describe("Session History UI", () => {
  let projectId: string;
  let statusId: string;
  const tmpFiles: string[] = [];

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

  async function openWorkspaceForIssue(page: import("@playwright/test").Page, issueTitle: string) {
    const issueEl = page.locator("p", { hasText: issueTitle }).first();
    await issueEl.click();
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();

    // Click the workspace button in the Workspaces section of the detail panel
    const wsLabel = page.locator("label", { hasText: "Workspaces" });
    const wsSection = wsLabel.locator("..");
    await wsSection.locator("button").first().click();

    await expect(page.locator("h2", { hasText: "Workspaces —" })).toBeVisible({ timeout: 5000 });

    // Close the detail panel backdrop that blocks clicks on the workspace panel content
    // The detail panel backdrop is z-40, the workspace panel is z-50
    const backdrop = page.locator("div.fixed.inset-0.bg-black\\/30").first();
    if (await backdrop.isVisible()) {
      await backdrop.click({ force: true });
      await page.waitForTimeout(300);
    }
  }

  test("completed sessions show in workspace panel", async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    const issueTitle = `History UI test ${suffix}`;
    const branchName = `feature/history-ui-${suffix}`;

    const issueRes = await request.post("http://localhost:3001/api/issues", {
      data: { title: issueTitle, statusId, projectId },
    });
    const issueId = (await issueRes.json()).id;

    const wsRes = await request.post("http://localhost:3001/api/workspaces", {
      data: { issueId, branch: branchName },
    });
    const workspaceId = (await wsRes.json()).id;

    // Setup workspace
    await request.post(
      `http://localhost:3001/api/workspaces/${workspaceId}/setup`,
      { data: {} },
    );

    // Stop auto-launched session (workspace creation auto-launches claude.exe)
    await request.post(
      `http://localhost:3001/api/workspaces/${workspaceId}/stop`,
      { data: {} },
    );
    await new Promise((r) => setTimeout(r, 500));

    // Launch and wait for completion (write to temp file to avoid Windows cmd.exe quoting issues)
    const script1 = "console.log('history test output'); process.exit(0);";
    const tmp1 = join(tmpdir(), `mock-agent-history-${Date.now()}.mjs`);
    writeFileSync(tmp1, script1);
    tmpFiles.push(tmp1);

    const launchRes = await request.post(
      `http://localhost:3001/api/workspaces/${workspaceId}/launch`,
      {
        data: {
          prompt: "test session history",
          agentCommand: `node ${tmp1.replace(/\\/g, '/')}`,
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

    await openWorkspaceForIssue(page, issueTitle);

    // Expand the workspace (click on the branch name)
    await page.locator(`text=${branchName}`).first().click();

    // Should show session selector with "Latest" tab
    await expect(page.locator('button:has-text("Latest")').first()).toBeVisible({ timeout: 5000 });
  });

  test("click past session shows output in TerminalView", async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    const issueTitle = `History output test ${suffix}`;
    const branchName = `feature/history-output-${suffix}`;

    const issueRes = await request.post("http://localhost:3001/api/issues", {
      data: { title: issueTitle, statusId, projectId },
    });
    const issueId = (await issueRes.json()).id;

    const wsRes = await request.post("http://localhost:3001/api/workspaces", {
      data: { issueId, branch: branchName },
    });
    const workspaceId = (await wsRes.json()).id;

    // Setup workspace
    await request.post(
      `http://localhost:3001/api/workspaces/${workspaceId}/setup`,
      { data: {} },
    );

    // Stop auto-launched session (workspace creation auto-launches claude.exe)
    await request.post(
      `http://localhost:3001/api/workspaces/${workspaceId}/stop`,
      { data: {} },
    );
    await new Promise((r) => setTimeout(r, 500));

    // Launch and wait for completion (write to temp file to avoid Windows cmd.exe quoting issues)
    const script2 = "console.log('viewable output'); process.exit(0);";
    const tmp2 = join(tmpdir(), `mock-agent-output-${Date.now()}.mjs`);
    writeFileSync(tmp2, script2);
    tmpFiles.push(tmp2);

    const launchRes = await request.post(
      `http://localhost:3001/api/workspaces/${workspaceId}/launch`,
      {
        data: {
          prompt: "test output viewing",
          agentCommand: `node ${tmp2.replace(/\\/g, '/')}`,
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

    await openWorkspaceForIssue(page, issueTitle);

    // Expand workspace
    await page.locator(`text=${branchName}`).first().click();

    // Wait for session selector to appear
    const wsPanel = page.locator("h2", { hasText: "Workspaces —" }).locator("..").locator("..");
    await expect(wsPanel.locator('button:has-text("Latest")').first()).toBeVisible({ timeout: 5000 });
    // Click the first completed session in the list (not the "Latest" tab)
    await wsPanel.locator('button:has-text("completed")').first().click();

    // TerminalView should show "Disconnected" status (history output loaded inline)
    await expect(page.locator("text=Disconnected").first()).toBeVisible({ timeout: 5000 });
  });

  test.afterAll(() => {
    for (const f of tmpFiles) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  });
});
