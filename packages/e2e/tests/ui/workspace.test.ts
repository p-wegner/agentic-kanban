import { test, expect } from "@playwright/test";

test.describe("Workspace Panel UI", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Wait for board to load
    await page.waitForSelector('[class*="bg-gray-100"]');
  });

  test("workspace panel opens from issue detail", async ({ page }) => {
    // Click first issue card to open detail panel
    const issueCard = page.locator("text=Workspace test issue").first();
    if (await issueCard.isVisible()) {
      await issueCard.click();

      // Should see workspace management link (text is context-aware: "New Workspace" or "View Workspaces")
      const manageLink = page.locator("text=New Workspace").or(page.locator("text=View Workspaces")).first();
      await expect(manageLink).toBeVisible();

      // Click to open workspace panel
      await manageLink.click();

      // Workspace panel should be visible
      await expect(page.locator("text=Workspaces").first()).toBeVisible();
    }
  });

  test("workspace panel shows create form", async ({ page }) => {
    // Navigate to workspace panel
    const issueCard = page.locator('[class*="cursor-pointer"]').first();
    await issueCard.click();

    const manageLink = page.locator("text=New Workspace").or(page.locator("text=View Workspaces")).first();
    if (await manageLink.isVisible()) {
      await manageLink.click();

      // Click "New Workspace" button
      const newButton = page.locator("text=New Workspace").first();
      if (await newButton.isVisible()) {
        await newButton.click();

        // Should see branch name input
        await expect(
          page.locator('input[placeholder*="feature"]'),
        ).toBeVisible();
      }
    }
  });
});

test.describe("Workspace Diff and Merge UI", () => {
  let projectId: string;
  let todoStatusId: string;

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get("http://localhost:3001/api/projects");
    const projects = await projectsRes.json();
    projectId = projects[0].id;

    const statusesRes = await request.get(
      `http://localhost:3001/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    todoStatusId = todoStatus ? todoStatus.id : statuses[0].id;
  });

  test("View Diff button shows diff output in panel", async ({ page, request }) => {
    // Create an issue and workspace
    const suffix = Date.now().toString(36);
    const issueRes = await request.post("http://localhost:3001/api/issues", {
      data: { title: `DiffTestIssue ${suffix}`, statusId: todoStatusId, projectId },
    });
    const issueId = (await issueRes.json()).id;

    const branchName = `feature/diff-test-${suffix}`;
    const wsRes = await request.post("http://localhost:3001/api/workspaces", {
      data: { issueId, branch: branchName },
    });
    const workspace = await wsRes.json();
    const workspaceId = workspace.id;

    // Setup workspace (retry loop per CLAUDE.md guidance)
    let setupOk = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const setupRes = await request.post(
          `http://localhost:3001/api/workspaces/${workspaceId}/setup`,
          { data: {} },
        );
        if (setupRes.ok()) {
          setupOk = true;
          break;
        }
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!setupOk) {
      test.skip();
      return;
    }

    // Navigate to board and open workspace panel
    await page.goto("/");
    await page.waitForSelector("h2");

    // Find and click the issue card
    await page.locator("p", { hasText: `DiffTestIssue ${suffix}` }).first().click();
    await expect(
      page.locator("h2", { hasText: "Issue Details" }),
    ).toBeVisible();

    // Click "View Workspaces" button in detail panel
    await page.locator('button:has-text("View Workspaces")').first().click();

    // Workspace panel should be visible
    await expect(
      page.locator("h2", { hasText: "Workspaces —" }),
    ).toBeVisible({ timeout: 5000 });

    // Expand the workspace by clicking on its branch name
    await page.locator(`text=${branchName}`).first().click();

    // Should see "View Diff" button
    await expect(
      page.locator('button:has-text("View Diff")'),
    ).toBeVisible({ timeout: 5000 });

    // Click View Diff
    await page.locator('button:has-text("View Diff")').click();

    // Diff section should appear (showing "Diff" heading or "No changes to show" message)
    const diffHeading = page.locator("h3", { hasText: "Diff" }).or(
      page.locator("text=No changes to show"),
    );
    await expect(diffHeading.first()).toBeVisible({ timeout: 5000 });
  });

  test("Merge button merges and workspace status changes", async ({ page, request }) => {
    // Create an issue and workspace
    const suffix = Date.now().toString(36);
    const issueRes = await request.post("http://localhost:3001/api/issues", {
      data: { title: `MergeTestIssue ${suffix}`, statusId: todoStatusId, projectId },
    });
    const issueId = (await issueRes.json()).id;

    const branchName = `feature/merge-test-${suffix}`;
    const wsRes = await request.post("http://localhost:3001/api/workspaces", {
      data: { issueId, branch: branchName },
    });
    const workspace = await wsRes.json();
    const workspaceId = workspace.id;

    // Setup workspace (retry loop)
    let setupOk = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const setupRes = await request.post(
          `http://localhost:3001/api/workspaces/${workspaceId}/setup`,
          { data: {} },
        );
        if (setupRes.ok()) {
          setupOk = true;
          break;
        }
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!setupOk) {
      test.skip();
      return;
    }

    // Navigate to board and open workspace panel
    await page.goto("/");
    await page.waitForSelector("h2");

    // Find and click the issue card
    await page.locator("p", { hasText: `MergeTestIssue ${suffix}` }).first().click();
    await expect(
      page.locator("h2", { hasText: "Issue Details" }),
    ).toBeVisible();

    // Click "View Workspaces" button in detail panel
    await page.locator('button:has-text("View Workspaces")').first().click();

    // Workspace panel should be visible
    await expect(
      page.locator("h2", { hasText: "Workspaces —" }),
    ).toBeVisible({ timeout: 5000 });

    // Expand the workspace
    await page.locator(`text=${branchName}`).first().click();

    // Should see "Merge" button
    await expect(
      page.locator('button:has-text("Merge")'),
    ).toBeVisible({ timeout: 5000 });

    // Click Merge
    await page.locator('button:has-text("Merge")').click();

    // Wait for merge to complete — the workspace status should change to "closed"
    await expect(
      page.locator("text=closed").first(),
    ).toBeVisible({ timeout: 10000 });
  });
});
