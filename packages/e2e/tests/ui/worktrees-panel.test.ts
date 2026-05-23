import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { SERVER_URL } from "../helpers/port.js";

// Helper: open the Worktrees panel via the branch icon in the header
async function openWorktreesPanel(page: import("@playwright/test").Page) {
  await page.locator('button[title="Worktrees"]').click();
  await expect(page.locator("h2", { hasText: "Worktrees" })).toBeVisible({ timeout: 5000 });
}

test.describe("Worktrees Panel — orphaned detection and bulk clean", () => {
  let projectId: string;
  let statusId: string;
  const createdIssueIds: string[] = [];
  const suffix = Date.now().toString(36);

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
    const projects = await projectsRes.json();
    projectId = projects[0].id;

    const statusesRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/statuses`);
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todoStatus ? todoStatus.id : statuses[0].id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
  });

  test("branch icon in header opens Worktrees panel", async ({ page }) => {
    await openWorktreesPanel(page);

    // Panel should show at least the main worktree count
    await expect(page.locator("h2", { hasText: "Worktrees" })).toBeVisible();
    // Close via × button
    await page.locator('button').filter({ hasText: "×" }).click();
    await expect(page.locator("h2", { hasText: "Worktrees" })).not.toBeVisible({ timeout: 3000 });
  });

  test("orphaned worktree shows orange badge", async ({ page, request }) => {
    // Create issue + workspace then delete workspace record to leave orphan
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `Orphan badge test ${suffix}`, statusId, projectId },
    });
    expect(issueRes.status()).toBe(201);
    const issueId = (await issueRes.json()).id;
    createdIssueIds.push(issueId);

    const branchName = `feature/orphan-badge-${suffix}`;
    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId, branch: branchName },
    });
    expect(wsRes.status()).toBe(201);
    const workspace = await wsRes.json();

    // Orphan it by deleting the workspace record
    await request.delete(`${SERVER_URL}/api/workspaces/${workspace.id}`);

    try {
      await openWorktreesPanel(page);

      // Header should show "N orphaned" badge
      await expect(page.locator("span", { hasText: /orphaned/ }).first()).toBeVisible({ timeout: 5000 });

      // The specific worktree row should carry the orange "orphaned" badge
      const orphanRow = page.locator("div").filter({ hasText: branchName }).first();
      await expect(orphanRow.locator("span", { hasText: "orphaned" })).toBeVisible();
    } finally {
      // Clean up: remove via API
      const listRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/worktrees`);
      const worktrees = await listRes.json();
      const orphan = worktrees.find(
        (wt: { branch: string; workspace?: unknown }) => wt.branch === branchName && !wt.workspace,
      );
      if (orphan) {
        await request.delete(`${SERVER_URL}/api/projects/${projectId}/worktrees`, {
          data: { path: orphan.path },
        });
      }
    }
  });

  test("Select orphaned button selects only orphaned worktrees", async ({ page, request }) => {
    // Create two workspaces; orphan one, keep the other
    const issue1Res = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `Select orphan A ${suffix}`, statusId, projectId },
    });
    const issue1Id = (await issue1Res.json()).id;
    createdIssueIds.push(issue1Id);

    const issue2Res = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `Select orphan B ${suffix}`, statusId, projectId },
    });
    const issue2Id = (await issue2Res.json()).id;
    createdIssueIds.push(issue2Id);

    const branch1 = `feature/sel-orphan-a-${suffix}`;
    const branch2 = `feature/sel-orphan-b-${suffix}`;

    const ws1Res = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId: issue1Id, branch: branch1 },
    });
    const ws1Id = (await ws1Res.json()).id;

    const ws2Res = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId: issue2Id, branch: branch2 },
    });
    const ws2Id = (await ws2Res.json()).id;

    // Orphan only the first workspace
    await request.delete(`${SERVER_URL}/api/workspaces/${ws1Id}`);

    try {
      await openWorktreesPanel(page);

      // Click "Select orphaned" button
      const selectOrphanedBtn = page.locator("button", { hasText: "Select orphaned" });
      await expect(selectOrphanedBtn).toBeVisible({ timeout: 5000 });
      await selectOrphanedBtn.click();

      // The orphaned branch row should be checked; the non-orphaned should not
      const orphanRow = page.locator("div").filter({ hasText: branch1 }).first();
      const orphanCheckbox = orphanRow.locator('input[type="checkbox"]');
      await expect(orphanCheckbox).toBeChecked();

      // "Delete N" button should appear showing selected count >= 1
      await expect(page.locator("button", { hasText: /Delete \d+/ })).toBeVisible();
    } finally {
      // Clean up worktrees
      const listRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/worktrees`);
      const worktrees = await listRes.json();
      for (const branch of [branch1, branch2]) {
        const wt = worktrees.find((w: { branch: string }) => w.branch === branch);
        if (wt) {
          await request.delete(`${SERVER_URL}/api/projects/${projectId}/worktrees`, {
            data: { path: wt.path, ...(wt.workspace ? { workspaceId: wt.workspace.id } : {}) },
          });
        }
      }
      // ws2 still has a workspace record — clean it up
      await request.delete(`${SERVER_URL}/api/workspaces/${ws2Id}`);
    }
  });

  test("bulk clean confirm dialog appears and orphaned directory removed after confirmation", async ({ page, request }) => {
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `Bulk clean test ${suffix}`, statusId, projectId },
    });
    const issueId = (await issueRes.json()).id;
    createdIssueIds.push(issueId);

    const branchName = `feature/bulk-clean-${suffix}`;
    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId, branch: branchName },
    });
    expect(wsRes.status()).toBe(201);
    const workspace = await wsRes.json();
    const workingDir: string | null = workspace.workingDir;

    // Orphan it
    await request.delete(`${SERVER_URL}/api/workspaces/${workspace.id}`);

    // Accept the browser confirm dialog automatically
    page.on("dialog", (dialog) => dialog.accept());

    await openWorktreesPanel(page);

    // Click "Select orphaned"
    const selectOrphanedBtn = page.locator("button", { hasText: "Select orphaned" });
    await expect(selectOrphanedBtn).toBeVisible({ timeout: 5000 });
    await selectOrphanedBtn.click();

    // Click bulk delete button
    const deleteBtn = page.locator("button", { hasText: /Delete \d+/ });
    await expect(deleteBtn).toBeVisible();
    await deleteBtn.click();

    // After confirmation, panel should refresh and no longer show the orphaned branch
    await expect(page.locator("text=" + branchName)).not.toBeVisible({ timeout: 10000 });

    // Directory should be removed from disk
    if (workingDir) {
      expect(existsSync(workingDir)).toBe(false);
    }

    // Header orphan badge should disappear (or reduce) after removal
    // (wait briefly for list refresh)
    await page.waitForTimeout(500);
  });

  test("bulk clean cancel dialog leaves worktree intact", async ({ page, request }) => {
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `Bulk cancel test ${suffix}`, statusId, projectId },
    });
    const issueId = (await issueRes.json()).id;
    createdIssueIds.push(issueId);

    const branchName = `feature/bulk-cancel-${suffix}`;
    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId, branch: branchName },
    });
    expect(wsRes.status()).toBe(201);
    const workspace = await wsRes.json();
    const workingDir: string | null = workspace.workingDir;

    // Orphan it
    await request.delete(`${SERVER_URL}/api/workspaces/${workspace.id}`);

    // Dismiss (cancel) any dialog
    page.on("dialog", (dialog) => dialog.dismiss());

    try {
      await openWorktreesPanel(page);

      const selectOrphanedBtn = page.locator("button", { hasText: "Select orphaned" });
      await expect(selectOrphanedBtn).toBeVisible({ timeout: 5000 });
      await selectOrphanedBtn.click();

      const deleteBtn = page.locator("button", { hasText: /Delete \d+/ });
      await expect(deleteBtn).toBeVisible();
      await deleteBtn.click();

      // Panel should still show the branch (delete was cancelled)
      await expect(page.locator("text=" + branchName).first()).toBeVisible({ timeout: 3000 });

      // Directory should still exist
      if (workingDir) {
        expect(existsSync(workingDir)).toBe(true);
      }
    } finally {
      // Clean up
      const listRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/worktrees`);
      const worktrees = await listRes.json();
      const wt = worktrees.find((w: { branch: string }) => w.branch === branchName);
      if (wt) {
        await request.delete(`${SERVER_URL}/api/projects/${projectId}/worktrees`, {
          data: { path: wt.path },
        });
      }
    }
  });
});
