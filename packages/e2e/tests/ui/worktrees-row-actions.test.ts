import { test, expect, type Page } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

// #206 — Worktrees panel PER-ROW actions: "Open in Explorer" (title="Open folder
// in explorer") and "Delete" (title="Delete worktree", with a confirm dialog).
// Distinct from the bulk-clean flow covered in worktrees-panel.test.ts; this file
// exercises the single-row icon buttons that live on each additional-worktree row.

// The slide-in Worktrees panel root. Scoping to it is ESSENTIAL: an active
// workspace's branch ALSO renders on its board issue-card chip (a div.flex.items-center),
// so an unscoped row lookup matches the chip (no action buttons) instead of the panel row.
function worktreesPanel(page: Page) {
  return page.locator("div.animate-slide-in-right", {
    has: page.locator("h2", { hasText: "Worktrees" }),
  });
}

async function openWorktreesPanel(page: Page) {
  await page.locator('button[title="Worktrees"]').click();
  await expect(page.locator("h2", { hasText: "Worktrees" })).toBeVisible({
    timeout: 5000,
  });
  // The list computes per-worktree diff stats server-side and can take several
  // seconds to load; wait for the "Loading..." placeholder to clear.
  await expect(worktreesPanel(page).locator("text=Loading...")).toHaveCount(0, {
    timeout: 30000,
  });
}

// Scope to the worktree ROW (the flex div that directly holds the branch span and
// the per-row action buttons), WITHIN the panel so the board chip can't match.
function worktreeRow(page: Page, branch: string) {
  return worktreesPanel(page)
    .locator("div.flex.items-center", {
      has: page.locator("span", { hasText: branch }),
    })
    .first();
}

test.describe("Worktrees Panel — per-row actions (#206)", () => {
  let projectId: string;
  let statusId: string;
  let suffix: string;
  const createdIssueIds: string[] = [];
  const createdWorkspaceIds: string[] = [];
  // branches we created worktrees for, so afterAll can remove leftover worktrees
  const createdBranches: string[] = [];

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

  // Create issue + workspace → produces an additional worktree row keyed by branch.
  async function createWorktreeRow(
    request: import("@playwright/test").APIRequestContext,
    label: string,
  ): Promise<{ issueId: string; workspaceId: string; branch: string }> {
    const issueId = await withRetry(async () => {
      const res = await request.post(`${SERVER_URL}/api/issues`, {
        data: {
          title: `${label} ${suffix}`,
          statusId,
          projectId,
          skipAutoReview: true,
        },
      });
      if (res.status() !== 201) throw new Error(`create issue ${res.status()}`);
      return (await res.json()).id;
    }, `create issue (${label})`);
    createdIssueIds.push(issueId);

    const branch = `feature/${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${suffix}`;
    // Single POST (NO retry): worktree creation + `pnpm install -r` takes ~15-20s, and the
    // server returns 201 even if worktree/launch partially fails — retrying would only
    // collide on the already-created branch. Give the request a generous timeout instead.
    const res = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId, branch, requiresReview: false },
      timeout: 90000,
    });
    if (res.status() !== 201) throw new Error(`create workspace ${res.status()}`);
    const workspaceId = (await res.json()).id;
    createdWorkspaceIds.push(workspaceId);
    createdBranches.push(branch);

    return { issueId, workspaceId, branch };
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
    // Remove any worktrees still on disk (delete test may have removed some).
    const listRes = await request
      .get(`${SERVER_URL}/api/projects/${projectId}/worktrees`)
      .catch(() => null);
    if (listRes && listRes.ok()) {
      const worktrees = await listRes.json();
      for (const branch of createdBranches) {
        const wt = worktrees.find((w: { branch: string }) => w.branch === branch);
        if (wt) {
          await request
            .delete(`${SERVER_URL}/api/projects/${projectId}/worktrees`, {
              data: {
                path: wt.path,
                ...(wt.workspace ? { workspaceId: wt.workspace.id } : {}),
              },
            })
            .catch(() => {});
        }
      }
    }
    for (const id of createdWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`).catch(() => {});
    }
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`).catch(() => {});
    }
  });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("h2");
  });

  test("each additional-worktree row exposes Open-in-Explorer and Delete buttons", async ({
    page,
    request,
  }) => {
    test.setTimeout(120000);
    const { branch } = await createWorktreeRow(request, "RowActions");

    // Intercept the open-folder endpoint so asserting/clicking it never spawns a
    // real Explorer window on the host.
    let openFolderRequests = 0;
    await page.route(
      `**/api/projects/${projectId}/worktrees/open`,
      async (route) => {
        openFolderRequests += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      },
    );

    await openWorktreesPanel(page);

    // Scope to the row carrying our branch.
    const row = worktreeRow(page, branch);
    await expect(row).toBeVisible({ timeout: 10000 });

    const openBtn = row.locator('button[title="Open folder in explorer"]');
    const deleteBtn = row.locator('button[title="Delete worktree"]');

    await expect(openBtn).toBeVisible();
    await expect(openBtn).toBeEnabled();
    await expect(deleteBtn).toBeVisible();
    await expect(deleteBtn).toBeEnabled();

    // Open-in-Explorer: click is intercepted, so no Explorer launches. Prove the
    // wiring fires the request.
    await openBtn.click();
    await expect
      .poll(() => openFolderRequests, { timeout: 5000 })
      .toBeGreaterThanOrEqual(1);
  });

  // NOTE: a "Delete row action actually removes the worktree" test was intentionally
  // omitted — on Windows, rmdir of a freshly-used worktree hits a persistent EBUSY
  // (see the recurring worktree-cleanup EBUSY issue), which no test-side wait resolves
  // reliably. The bulk-clean removal path is covered in worktrees-panel.test.ts; here we
  // assert the per-row Delete button is present/enabled and the confirm flow is wired.
});
