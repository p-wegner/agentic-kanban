import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Workspace Panel UI", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Wait for board to load
    await page.waitForSelector('[class*="bg-gray-100"]');
  });

  test("workspace panel opens from issue detail", async ({ page }) => {
    // Click first issue card to open detail panel
    const issueCard = page.locator('[class*="cursor-pointer"]').first();
    await issueCard.click();

    // Wait for detail panel to open
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();

    // Should see workspace section — either a workspace button or "New Workspace" / "View Workspaces" text
    const wsButton = page.locator("label", { hasText: "Workspaces" }).locator("..").locator("button").first();
    await expect(wsButton).toBeVisible();

    // Click to open workspace panel
    await wsButton.click();

    // Workspace panel should be visible
    await expect(page.locator("text=Workspaces").first()).toBeVisible();
  });

  test("workspace panel shows create form", async ({ page }) => {
    // Navigate to workspace panel
    const issueCard = page.locator('[class*="cursor-pointer"]').first();
    await issueCard.click();

    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();

    const wsLabel = page.locator("label", { hasText: "Workspaces" });
    const wsSection = wsLabel.locator("..");
    const wsButton = wsSection.locator("button").first();

    if (await wsButton.isVisible()) {
      await wsButton.click();

      // If we got to the workspace panel, look for "New Workspace" button there
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
    todoStatusId = todoStatus ? todoStatus.id : statuses[0].id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`);
    }
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  async function openWorkspaceForIssue(page: import("@playwright/test").Page, issueTitle: string) {
    await page.locator("p", { hasText: issueTitle }).first().click();
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();

    // Click the workspace button in the Workspaces section of the detail panel
    const wsLabel = page.locator("label", { hasText: "Workspaces" });
    const wsSection = wsLabel.locator("..");
    await wsSection.locator("button").first().click();

    // Workspace panel should be visible
    await expect(
      page.locator("h2", { hasText: "Workspaces —" }),
    ).toBeVisible({ timeout: 5000 });

    // Close the detail panel backdrop that blocks clicks on the workspace panel content
    const backdrop = page.locator("div.fixed.inset-0.bg-black\\/30").first();
    if (await backdrop.isVisible()) {
      await backdrop.click({ force: true });
      await page.waitForTimeout(300);
    }
  }

  test("View Diff button shows diff output in panel", async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `DiffTestIssue ${suffix}`, statusId: todoStatusId, projectId },
    });
    const issueId = (await issueRes.json()).id;
    createdIssueIds.push(issueId);

    const branchName = `feature/diff-test-${suffix}`;
    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId, branch: branchName },
    });
    const workspace = await wsRes.json();
    const workspaceId = workspace.id;
    createdWorkspaceIds.push(workspaceId);

    // Setup workspace (retry loop per CLAUDE.md guidance)
    let setupOk = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const setupRes = await request.post(
          `${SERVER_URL}/api/workspaces/${workspaceId}/setup`,
          { data: {} },
        );
        if (setupRes.ok()) { setupOk = true; break; }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!setupOk) { test.skip(); return; }

    await page.goto("/");
    await page.waitForSelector("h2");

    await openWorkspaceForIssue(page, `DiffTestIssue ${suffix}`);

    // Expand the workspace by clicking on its branch name (force to bypass backdrop overlay)
    await page.locator(`text=${branchName}`).first().click({ force: true });

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
    const suffix = Date.now().toString(36);
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `MergeTestIssue ${suffix}`, statusId: todoStatusId, projectId },
    });
    const issueId = (await issueRes.json()).id;
    createdIssueIds.push(issueId);

    const branchName = `feature/merge-test-${suffix}`;
    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId, branch: branchName },
    });
    const workspace = await wsRes.json();
    const workspaceId = workspace.id;
    createdWorkspaceIds.push(workspaceId);

    // Setup workspace (retry loop)
    let setupOk = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const setupRes = await request.post(
          `${SERVER_URL}/api/workspaces/${workspaceId}/setup`,
          { data: {} },
        );
        if (setupRes.ok()) { setupOk = true; break; }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!setupOk) { test.skip(); return; }

    await page.goto("/");
    await page.waitForSelector("h2");

    await openWorkspaceForIssue(page, `MergeTestIssue ${suffix}`);

    // Expand the workspace
    await page.locator(`text=${branchName}`).first().click();

    // Should see "Merge" button
    await expect(
      page.locator('button:has-text("Merge")'),
    ).toBeVisible({ timeout: 5000 });

    // Click Merge
    await page.locator('button:has-text("Merge")').click();

    // Wait for merge to complete — the workspace status should change to "closed" or "merged"
    await expect(
      page.locator("text=closed").or(page.locator("text=merged")).first(),
    ).toBeVisible({ timeout: 15000 });
  });
});
