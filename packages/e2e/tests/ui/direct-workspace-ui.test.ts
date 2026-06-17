import {
  test,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

// #195 — Direct workspace UI. A DIRECT workspace (created with isDirect: true)
// operates on the project's main checkout (workingDir = repoPath, no worktree).
// In the WorkspacePanel it is distinguished by:
//   • a purple "direct" badge next to the branch name
//     (span.bg-brand-50.text-brand-700 ... > "direct", from WorkspacePanel.tsx)
//   • the diff button reads "View Changes" instead of "View Diff"
//   • the merge button reads "Close" instead of "Merge"
// (See WorkspacePanel.tsx: `ws.isDirect ? "View Changes" : "View Diff"` and
//  `ws.isDirect ? "Close" : "Merge"`.)
//
// A direct workspace needs no /setup call — the server sets workingDir = repoPath
// and auto-detects the current branch, so the action buttons (gated on
// ws.workingDir) render immediately.

test.describe("Direct workspace UI (#195)", () => {
  let projectId: string;
  let statusId: string;
  let suffix: string;
  const createdIssueIds: string[] = [];
  const createdWorkspaceIds: string[] = [];

  async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    throw new Error(`[${label}] failed after 3 attempts: ${String(lastErr)}`);
  }

  function workspacePanel(page: Page, issueTitle: string): Locator {
    return page
      .locator("[data-panel]", { has: page.locator("h2", { hasText: issueTitle }) })
      .first();
  }

  async function openWorkspacePanel(
    page: Page,
    issueTitle: string,
  ): Promise<Locator> {
    const issueCardTitle = page.locator("p", { hasText: issueTitle }).first();
    await expect(issueCardTitle).toBeVisible({ timeout: 10000 });
    await issueCardTitle.click();
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();

    // Open the Workspaces panel from the detail panel's Workspaces section.
    const wsLabel = page.locator("label", { hasText: "Workspaces" });
    const wsSection = wsLabel.locator("..");
    const workspaceButton = wsSection.locator("button").first();
    await expect(workspaceButton).toBeVisible({ timeout: 10000 });
    await workspaceButton.click();

    // The workspace panel opens on top of the issue detail (z-50 slide-in) and its
    // header is the issue title — no need to close the issue detail (its × is covered by
    // the workspace panel and the badge/buttons we assert on live in the top panel).
    await expect(page.locator("h2", { hasText: issueTitle })).toBeVisible({
      timeout: 5000,
    });

    return workspacePanel(page, issueTitle);
  }

  test.beforeAll(async ({ request }) => {
    projectId = await withRetry(() => getE2EProjectId(request), "getE2EProjectId");

    const statuses = await withRetry(async () => {
      const res = await request.get(
        `${SERVER_URL}/api/projects/${projectId}/statuses`,
      );
      if (!res.ok()) throw new Error(`statuses ${res.status()}`);
      return res.json();
    }, "fetch statuses");
    const todo = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todo ? todo.id : statuses[0].id;

    suffix = Date.now().toString(36);
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`).catch(() => {});
    }
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`).catch(() => {});
    }
  });

  test("direct workspace shows purple 'direct' badge and Close / View Changes labels", async ({
    page,
    request,
  }) => {
    const issueTitle = `DirectWs ${suffix}`;

    const issueId = await withRetry(async () => {
      const res = await request.post(`${SERVER_URL}/api/issues`, {
        data: { title: issueTitle, statusId, projectId, skipAutoReview: true },
      });
      if (res.status() !== 201) throw new Error(`create issue ${res.status()}`);
      return (await res.json()).id;
    }, "create issue");
    createdIssueIds.push(issueId);

    // isDirect:true → no worktree, workingDir = repoPath. requiresReview:false so
    // it does not auto-launch a review. No branch needed (server auto-detects).
    const workspace = await withRetry(async () => {
      const res = await request.post(`${SERVER_URL}/api/workspaces`, {
        data: { issueId, isDirect: true, requiresReview: false },
      });
      if (res.status() !== 201) throw new Error(`create direct workspace ${res.status()}`);
      return res.json();
    }, "create direct workspace");
    createdWorkspaceIds.push(workspace.id);
    // Sanity: the API must actually have flagged it direct.
    expect(workspace.isDirect, "workspace was not created as direct").toBe(true);

    await page.goto("/");
    await page.waitForSelector("h2");

    const panel = await openWorkspacePanel(page, issueTitle);

    // The purple "direct" badge (scoped to the panel). Its branch row carries a
    // span with the brand background and exact text "direct".
    const directBadge = panel
      .locator("span.bg-brand-50", { hasText: /^direct$/ })
      .first();
    await expect(directBadge).toBeVisible({ timeout: 10000 });

    // Direct workspaces relabel the action buttons.
    const viewChangesBtn = panel.locator("button", { hasText: /^View Changes$/ }).first();
    await expect(viewChangesBtn).toBeVisible({ timeout: 10000 });

    const closeBtn = panel.locator("button", { hasText: /^Close$/ }).first();
    await expect(closeBtn).toBeVisible();

    // And the non-direct labels must NOT be present for this workspace.
    await expect(panel.locator("button", { hasText: /^View Diff$/ })).toHaveCount(0);
    await expect(panel.locator("button", { hasText: /^Merge$/ })).toHaveCount(0);
  });
});
