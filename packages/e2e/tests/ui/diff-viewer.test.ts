import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

/**
 * Diff viewer E2E tests.
 *
 * Strategy: create a direct workspace (no worktree, no git ops) so the diff
 * endpoint works immediately without waiting for worktree setup. Inject
 * comments via REST API to seed state, then test UI rendering and CRUD.
 *
 * For the "actual diff content" tests we use a worktree workspace and commit
 * a real file, because the diff viewer only renders when there are actual
 * git changes.
 */

test.describe("Diff Viewer UI", () => {
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

  // Helper: open the WorkspacePanel for a given issue title and expand the
  // first workspace card. Returns when the "View Diff" button is visible.
  async function openWorkspacePanel(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    page: any,
    issueTitle: string,
    branchName: string,
  ) {
    await page.locator("p", { hasText: issueTitle }).first().click();
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();

    const wsLabel = page.locator("label", { hasText: "Workspaces" });
    const wsSection = wsLabel.locator("..");
    await wsSection.locator("button").first().click();

    await expect(
      page.locator("h2", { hasText: "Workspaces —" }),
    ).toBeVisible({ timeout: 5000 });

    // Dismiss detail-panel backdrop
    const backdrop = page.locator("div.fixed.inset-0.bg-black\\/30").first();
    if (await backdrop.isVisible()) {
      await backdrop.click({ force: true });
      await page.waitForTimeout(300);
    }

    // Expand the workspace row
    await page.locator(`text=${branchName}`).first().click({ force: true });
  }

  // ---------------------------------------------------------------------------
  // Worktree workspace with a committed file change — provides real diff output
  // ---------------------------------------------------------------------------

  test.describe("with real diff", () => {
    let workspaceId: string;
    let issueTitle: string;
    let branchName: string;

    test.beforeAll(async ({ request }) => {
      const suffix = Date.now().toString(36);
      issueTitle = `DiffViewerTest ${suffix}`;
      branchName = `feature/diff-viewer-${suffix}`;

      const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
        data: { title: issueTitle, statusId: todoStatusId, projectId },
      });
      const issueId = (await issueRes.json()).id;
      createdIssueIds.push(issueId);

      const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
        data: { issueId, branch: branchName },
      });
      const workspace = await wsRes.json();
      workspaceId = workspace.id;
      createdWorkspaceIds.push(workspaceId);

      // Wait for setup (retry loop)
      let setupOk = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await request.post(
            `${SERVER_URL}/api/workspaces/${workspaceId}/setup`,
            { data: {} },
          );
          if (r.ok()) { setupOk = true; break; }
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 500));
      }

      if (!setupOk) return; // tests in this group will call test.skip()

      // Commit a file change in the worktree so the diff is non-empty
      const addFileRes = await request.post(
        `${SERVER_URL}/api/workspaces/${workspaceId}/turn`,
        {
          data: {
            message:
              "Create a file called e2e-diff-test.txt with the text 'hello world' and commit it with message 'test: add e2e diff test file'",
          },
        },
      );

      // POST /turn returns 409 if agent already running — that's fine for setup
      // We just need to wait for the commit to land; poll the diff endpoint
      if (addFileRes.ok()) {
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          const diffRes = await request.get(
            `${SERVER_URL}/api/workspaces/${workspaceId}/diff`,
          );
          if (diffRes.ok()) {
            const d = await diffRes.json();
            if (d.stats?.filesChanged > 0) break;
          }
        }
      }
    });

    test("View Diff button shows diff stats header", async ({ page, request }) => {
      const diffCheck = await request.get(
        `${SERVER_URL}/api/workspaces/${workspaceId}/diff`,
      );
      if (!diffCheck.ok()) { test.skip(); return; }
      const d = await diffCheck.json();
      if (!d.stats || d.stats.filesChanged === 0) { test.skip(); return; }

      await page.goto("/");
      await page.waitForSelector("h2");

      await openWorkspacePanel(page, issueTitle, branchName);

      await expect(
        page.locator('button:has-text("View Diff")'),
      ).toBeVisible({ timeout: 5000 });
      await page.locator('button:has-text("View Diff")').click();

      // Diff stats header: "N file(s) changed"
      await expect(
        page.locator("text=/\\d+ files? changed/"),
      ).toBeVisible({ timeout: 5000 });

      // Green insertions counter (+N)
      await expect(page.locator(".text-green-600").filter({ hasText: /^\+\d+$/ }).first()).toBeVisible();
      // Red deletions counter (-N)
      await expect(page.locator(".text-red-600").filter({ hasText: /^-\d+$/ }).first()).toBeVisible();
    });

    test("file tree shows changed file and is expandable", async ({ page, request }) => {
      const diffCheck = await request.get(
        `${SERVER_URL}/api/workspaces/${workspaceId}/diff`,
      );
      if (!diffCheck.ok()) { test.skip(); return; }
      const d = await diffCheck.json();
      if (!d.stats || d.stats.filesChanged === 0) { test.skip(); return; }

      await page.goto("/");
      await page.waitForSelector("h2");

      await openWorkspacePanel(page, issueTitle, branchName);
      await page.locator('button:has-text("View Diff")').click();

      // FileDiffAccordion button renders the file path
      const fileAccordion = page.locator(
        'button.w-full.flex.items-center',
      ).first();
      await expect(fileAccordion).toBeVisible({ timeout: 5000 });

      // Collapse the file
      await fileAccordion.click();
      // After collapse the content div should disappear
      const diffContent = page.locator(".overflow-auto.max-h-80").first();
      await expect(diffContent).not.toBeVisible({ timeout: 2000 });

      // Expand again
      await fileAccordion.click();
      await expect(diffContent).toBeVisible({ timeout: 2000 });
    });

    test("diff content shows added lines", async ({ page, request }) => {
      const diffCheck = await request.get(
        `${SERVER_URL}/api/workspaces/${workspaceId}/diff`,
      );
      if (!diffCheck.ok()) { test.skip(); return; }
      const d = await diffCheck.json();
      if (!d.stats || d.stats.filesChanged === 0) { test.skip(); return; }

      await page.goto("/");
      await page.waitForSelector("h2");

      await openWorkspacePanel(page, issueTitle, branchName);
      await page.locator('button:has-text("View Diff")').click();

      // At least one green add line should be visible
      await expect(
        page.locator(".bg-green-50").first(),
      ).toBeVisible({ timeout: 5000 });
    });

    test("Unified/Split view toggle switches rendering", async ({ page, request }) => {
      const diffCheck = await request.get(
        `${SERVER_URL}/api/workspaces/${workspaceId}/diff`,
      );
      if (!diffCheck.ok()) { test.skip(); return; }
      const d = await diffCheck.json();
      if (!d.stats || d.stats.filesChanged === 0) { test.skip(); return; }

      await page.goto("/");
      await page.waitForSelector("h2");

      await openWorkspacePanel(page, issueTitle, branchName);
      await page.locator('button:has-text("View Diff")').click();

      // Default is unified; split button should exist
      await expect(page.locator('button:has-text("Unified")')).toBeVisible({ timeout: 5000 });
      await expect(page.locator('button:has-text("Split")')).toBeVisible();

      // Switch to split — should render a <table>
      await page.locator('button:has-text("Split")').click();
      await expect(page.locator("table").first()).toBeVisible({ timeout: 2000 });

      // Switch back to unified — table should be gone
      await page.locator('button:has-text("Unified")').click();
      await expect(page.locator("table")).not.toBeVisible({ timeout: 2000 });
    });
  });

  // ---------------------------------------------------------------------------
  // Comment CRUD — use a direct workspace so no git worktree is needed
  // ---------------------------------------------------------------------------

  test.describe("comment CRUD", () => {
    let workspaceId: string;
    let issueTitle: string;
    let branchName: string;

    test.beforeAll(async ({ request }) => {
      const suffix = Date.now().toString(36);
      issueTitle = `DiffCommentTest ${suffix}`;
      branchName = `feature/diff-comment-${suffix}`;

      const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
        data: { title: issueTitle, statusId: todoStatusId, projectId },
      });
      const issueId = (await issueRes.json()).id;
      createdIssueIds.push(issueId);

      // Create a worktree workspace (diff endpoint requires a real workspace)
      const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
        data: { issueId, branch: branchName },
      });
      const workspace = await wsRes.json();
      workspaceId = workspace.id;
      createdWorkspaceIds.push(workspaceId);

      // Wait for worktree setup
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await request.post(
            `${SERVER_URL}/api/workspaces/${workspaceId}/setup`,
            { data: {} },
          );
          if (r.ok()) break;
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 500));
      }
    });

    test("comment count badge appears in diff viewer header", async ({
      page,
      request,
    }) => {
      // Seed a comment directly via API
      const commentRes = await request.post(
        `${SERVER_URL}/api/workspaces/${workspaceId}/comments`,
        {
          data: {
            filePath: "src/example.ts",
            lineNumNew: 1,
            side: "new",
            body: "API-seeded comment for badge test",
          },
        },
      );
      expect(commentRes.status()).toBe(201);
      const comment = await commentRes.json();

      try {
        await page.goto("/");
        await page.waitForSelector("h2");

        await openWorkspacePanel(page, issueTitle, branchName);

        await expect(
          page.locator('button:has-text("View Diff")'),
        ).toBeVisible({ timeout: 5000 });
        await page.locator('button:has-text("View Diff")').click();

        // Wait for diff viewer to appear (may show "No changes to show" if branch is empty)
        const diffViewer = page
          .locator(".border.border-gray-300.rounded")
          .or(page.locator("text=No changes to show"))
          .first();
        await expect(diffViewer).toBeVisible({ timeout: 5000 });

        // The diff header shows comment count when comments exist
        // It's loaded from the diff endpoint which includes comments
        await expect(
          page.locator("text=/1 comment/"),
        ).toBeVisible({ timeout: 3000 });
      } finally {
        // Clean up comment
        await request.delete(
          `${SERVER_URL}/api/workspaces/${workspaceId}/comments/${comment.id}`,
        );
      }
    });

    test("comment shows timestamp", async ({ page, request }) => {
      const commentRes = await request.post(
        `${SERVER_URL}/api/workspaces/${workspaceId}/comments`,
        {
          data: {
            filePath: "src/example.ts",
            lineNumNew: 2,
            side: "new",
            body: "Timestamp display test comment",
          },
        },
      );
      expect(commentRes.status()).toBe(201);
      const comment = await commentRes.json();

      try {
        await page.goto("/");
        await page.waitForSelector("h2");

        await openWorkspacePanel(page, issueTitle, branchName);
        await page.locator('button:has-text("View Diff")').click();

        const diffViewer = page
          .locator(".border.border-gray-300.rounded")
          .or(page.locator("text=No changes to show"))
          .first();
        await expect(diffViewer).toBeVisible({ timeout: 5000 });

        // Comment block should be visible with the body text
        await expect(page.locator("text=Timestamp display test comment")).toBeVisible({ timeout: 3000 });

        // Timestamp should be shown in the comment block (formatted date/time)
        const commentBlock = page.locator(".bg-yellow-50").filter({ hasText: "Timestamp display test comment" }).first();
        // The timestamp span renders a short date-time string (non-empty)
        const timestampEl = commentBlock.locator("span.text-gray-400").first();
        await expect(timestampEl).toBeVisible({ timeout: 2000 });
        const timestampText = await timestampEl.textContent();
        expect(timestampText?.trim().length).toBeGreaterThan(0);
      } finally {
        await request.delete(
          `${SERVER_URL}/api/workspaces/${workspaceId}/comments/${comment.id}`,
        );
      }
    });

    test("comment create via UI: click diff line, type comment, submit", async ({
      page,
      request,
    }) => {
      // This test requires actual diff content to have clickable lines.
      const diffCheck = await request.get(
        `${SERVER_URL}/api/workspaces/${workspaceId}/diff`,
      );
      if (!diffCheck.ok()) { test.skip(); return; }
      const diffData = await diffCheck.json();
      if (!diffData.diff || !diffData.stats?.filesChanged) { test.skip(); return; }

      await page.goto("/");
      await page.waitForSelector("h2");

      await openWorkspacePanel(page, issueTitle, branchName);
      await page.locator('button:has-text("View Diff")').click();

      // Wait for diff viewer
      await expect(page.locator("text=/\\d+ files? changed/")).toBeVisible({ timeout: 5000 });

      // Hover over first diff line to reveal "+" button
      const firstLine = page.locator(".bg-green-50, .bg-red-50, .text-gray-700").first();
      await firstLine.hover();

      // Click the "+" button (visible on hover)
      const addBtn = firstLine.locator("span").filter({ hasText: "+" }).first();
      if (!(await addBtn.isVisible({ timeout: 1000 }))) {
        // Try clicking the line directly to open CommentInput
        await firstLine.click();
      } else {
        await addBtn.click();
      }

      // CommentInput should appear
      await expect(
        page.locator('textarea[placeholder="Write a comment..."]'),
      ).toBeVisible({ timeout: 3000 });

      const commentText = `E2E comment ${Date.now().toString(36)}`;
      await page.locator('textarea[placeholder="Write a comment..."]').fill(commentText);

      // Submit with Ctrl+Enter
      await page.locator('textarea[placeholder="Write a comment..."]').press("Control+Enter");

      // CommentInput should close
      await expect(
        page.locator('textarea[placeholder="Write a comment..."]'),
      ).not.toBeVisible({ timeout: 3000 });

      // Comment body should appear in a CommentBlock
      await expect(page.locator("text=" + commentText)).toBeVisible({ timeout: 3000 });

      // Clean up — delete all comments for this workspace
      const commentsRes = await request.get(
        `${SERVER_URL}/api/workspaces/${workspaceId}/comments`,
      );
      if (commentsRes.ok()) {
        const comments = await commentsRes.json();
        for (const c of comments) {
          await request.delete(
            `${SERVER_URL}/api/workspaces/${workspaceId}/comments/${c.id}`,
          );
        }
      }
    });

    test("comment edit and delete via UI", async ({ page, request }) => {
      // Seed a comment via API
      const seedRes = await request.post(
        `${SERVER_URL}/api/workspaces/${workspaceId}/comments`,
        {
          data: {
            filePath: "src/example.ts",
            lineNumNew: 5,
            side: "new",
            body: "Original comment body",
          },
        },
      );
      if (!seedRes.ok()) { test.skip(); return; }
      const seededComment = await seedRes.json();

      // Reload the diff in the UI so it picks up the seeded comment.
      // Since comments are returned by the diff endpoint, we need to open
      // the diff viewer fresh.
      await page.goto("/");
      await page.waitForSelector("h2");

      await openWorkspacePanel(page, issueTitle, branchName);
      await page.locator('button:has-text("View Diff")').click();

      await expect(
        page.locator(".border.border-gray-300.rounded").or(page.locator("text=No changes to show")).first(),
      ).toBeVisible({ timeout: 5000 });

      // The comment should be visible (seeded for this workspace)
      await expect(
        page.locator("text=Original comment body"),
      ).toBeVisible({ timeout: 3000 });

      // Hover to reveal Edit button (opacity-0 → opacity-100 on group-hover)
      const commentBlock = page
        .locator(".bg-yellow-50")
        .filter({ hasText: "Original comment body" })
        .first();
      await commentBlock.hover();

      // Click Edit
      await commentBlock.locator("button", { hasText: "Edit" }).click();

      // Edit textarea should appear pre-filled with original text
      const editTextarea = page.locator(
        ".bg-yellow-50 textarea",
      ).first();
      await expect(editTextarea).toBeVisible({ timeout: 2000 });
      await editTextarea.fill("Updated comment body");

      // Save
      await page.locator(".bg-yellow-50 button", { hasText: "Save" }).first().click();

      // Updated text should be visible; original gone
      await expect(page.locator("text=Updated comment body")).toBeVisible({ timeout: 3000 });
      await expect(page.locator("text=Original comment body")).not.toBeVisible();

      // Now delete the comment
      const updatedBlock = page
        .locator(".bg-yellow-50")
        .filter({ hasText: "Updated comment body" })
        .first();
      await updatedBlock.hover();
      await updatedBlock.locator("button", { hasText: "Delete" }).click();

      // Comment should be gone
      await expect(page.locator("text=Updated comment body")).not.toBeVisible({ timeout: 3000 });

      // Double-check via API
      const verifyRes = await request.get(
        `${SERVER_URL}/api/workspaces/${workspaceId}/comments`,
      );
      const remaining = await verifyRes.json();
      const stillExists = remaining.some((c: { id: string }) => c.id === seededComment.id);
      expect(stillExists).toBe(false);
    });

    test("comment badge count updates after adding a comment via API", async ({
      page,
      request,
    }) => {
      // Start with no comments
      const clearRes = await request.get(
        `${SERVER_URL}/api/workspaces/${workspaceId}/comments`,
      );
      if (clearRes.ok()) {
        const existing = await clearRes.json();
        for (const c of existing) {
          await request.delete(
            `${SERVER_URL}/api/workspaces/${workspaceId}/comments/${c.id}`,
          );
        }
      }

      await page.goto("/");
      await page.waitForSelector("h2");

      await openWorkspacePanel(page, issueTitle, branchName);
      await page.locator('button:has-text("View Diff")').click();

      const diffViewer = page
        .locator(".border.border-gray-300.rounded")
        .or(page.locator("text=No changes to show"))
        .first();
      await expect(diffViewer).toBeVisible({ timeout: 5000 });

      // No comments yet — comment badge should not appear
      await expect(page.locator("text=/\\d+ comment/")).not.toBeVisible({ timeout: 1000 });

      // Add a comment via API
      const c1 = await (
        await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/comments`, {
          data: { filePath: "src/foo.ts", lineNumNew: 1, side: "new", body: "Comment one" },
        })
      ).json();

      // Re-click View Diff to reload
      await page.locator('button:has-text("Close")').click();
      await page.locator('button:has-text("View Diff")').click();
      await expect(page.locator("text=/1 comment/")).toBeVisible({ timeout: 5000 });

      // Add second comment
      const c2 = await (
        await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/comments`, {
          data: { filePath: "src/foo.ts", lineNumNew: 2, side: "new", body: "Comment two" },
        })
      ).json();

      await page.locator('button:has-text("Close")').click();
      await page.locator('button:has-text("View Diff")').click();
      await expect(page.locator("text=/2 comments/")).toBeVisible({ timeout: 5000 });

      // Clean up
      for (const c of [c1, c2]) {
        await request.delete(
          `${SERVER_URL}/api/workspaces/${workspaceId}/comments/${c.id}`,
        );
      }
    });
  });
});
