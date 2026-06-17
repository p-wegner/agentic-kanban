import {
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProjectId } from "../helpers/e2e-project.js";

// #204 — "Open in VS Code" button in the workspace panel.
// The button (title="Open workspace directory in VS Code", label "VS Code") renders
// whenever `ws.workingDir` is truthy (WorkspacePanel.tsx ~2505). It is NOT gated on
// worktree/direct, so we exercise it on a DIRECT workspace (workingDir = repoPath, no
// worktree, no per-worktree install) — that opens the workspace panel reliably and fast.
// Clicking it calls POST /api/workspaces/:id/open-editor which spawns a real VS Code
// process; we intercept that request via page.route() so nothing launches on the host.

test.describe("Workspace 'Open in VS Code' button (#204)", () => {
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

  // Open the workspace panel via the issue detail Workspaces section (proven by
  // direct-workspace-ui.test.ts). For a direct workspace this resolves the single
  // workspace button and the panel header is the issue title.
  async function openWorkspacePanel(page: Page, issueTitle: string): Promise<Locator> {
    const issueCardTitle = page.locator("p", { hasText: issueTitle }).first();
    await expect(issueCardTitle).toBeVisible({ timeout: 10000 });
    await issueCardTitle.click();
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();

    const wsLabel = page.locator("label", { hasText: "Workspaces" });
    const wsSection = wsLabel.locator("..");
    const workspaceButton = wsSection.locator("button").first();
    await expect(workspaceButton).toBeVisible({ timeout: 10000 });
    await workspaceButton.click();

    // The workspace panel opens on top of the issue detail (z-50 slide-in) and its header
    // is the issue title — no need to close the issue detail; the panel is already topmost.
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

  test.afterAll(async ({ request }: { request: APIRequestContext }) => {
    for (const id of createdWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`).catch(() => {});
    }
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`).catch(() => {});
    }
  });

  test("VS Code button is present, enabled, and fires open-editor without spawning the editor", async ({
    page,
    request,
  }) => {
    const issueTitle = `VSCodeBtn ${suffix}`;

    const issueId = await withRetry(async () => {
      const res = await request.post(`${SERVER_URL}/api/issues`, {
        data: { title: issueTitle, statusId, projectId, skipAutoReview: true },
      });
      if (!res.ok()) throw new Error(`create issue ${res.status()}`);
      return (await res.json()).id;
    }, "create issue");
    createdIssueIds.push(issueId);

    // Direct workspace → workingDir = repoPath, no worktree. requiresReview:false.
    const workspace = await withRetry(async () => {
      const res = await request.post(`${SERVER_URL}/api/workspaces`, {
        data: { issueId, isDirect: true, requiresReview: false },
      });
      if (res.status() !== 201) throw new Error(`create direct workspace ${res.status()}`);
      return res.json();
    }, "create direct workspace");
    createdWorkspaceIds.push(workspace.id);
    expect(workspace.isDirect, "workspace was not created as direct").toBe(true);

    // CRITICAL: intercept the open-editor POST so clicking never launches a real VS Code
    // process on the host. We fulfill a benign 200 — the server route is never reached.
    let openEditorRequests = 0;
    await page.route(
      `**/api/workspaces/${workspace.id}/open-editor`,
      async (route) => {
        openEditorRequests += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      },
    );

    await page.goto("/");
    await page.waitForSelector("h2");

    const panel = await openWorkspacePanel(page, issueTitle);

    const vscodeButton = panel
      .locator('button[title="Open workspace directory in VS Code"]')
      .first();
    await expect(vscodeButton).toBeVisible({ timeout: 10000 });
    await expect(vscodeButton).toHaveText(/VS Code/);
    await expect(vscodeButton).toBeEnabled();

    // Click — the route interceptor catches it, so no external editor opens.
    await vscodeButton.click();

    await expect
      .poll(() => openEditorRequests, { timeout: 5000 })
      .toBeGreaterThanOrEqual(1);
  });
});
