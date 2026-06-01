/**
 * E2E tests for the workspace launch preview panel in the CreateWorkspaceForm.
 *
 * Strategy: create a test issue via API, navigate to the board, open the issue
 * detail panel, click "New Workspace", and assert that the LaunchPreviewPanel
 * renders resolved branch/base/profile details and surfaces warnings correctly.
 *
 * Warning path covered: existing active workspace on the same issue.
 */
import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProject } from "../helpers/e2e-project.js";

test.describe("Workspace launch preview panel", () => {
  let projectId: string;
  let todoStatusId: string;
  const createdIssueIds: string[] = [];
  const createdWorkspaceIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const project = await getE2EProject(request);
    projectId = project.id;

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    expect(statusesRes.ok(), "GET project statuses must succeed").toBeTruthy();
    const statuses: Array<{ id: string; name: string }> = await statusesRes.json();
    expect(statuses.length, "Project must have at least one status").toBeGreaterThan(0);
    const todoStatus = statuses.find((s) => s.name === "Todo");
    todoStatusId = todoStatus ? todoStatus.id : statuses[0].id;

    // Use mock profile so workspace creation does not launch a real agent
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { claude_profile: "mock" },
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
      data: { claude_profile: "" },
    });
  });

  async function createIssue(
    title: string,
    request: Parameters<Parameters<typeof test>[1]>[0]["request"],
  ): Promise<string> {
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title, statusId: todoStatusId, projectId, skipAutoReview: true },
    });
    expect(issueRes.status(), `POST /api/issues for "${title}"`).toBe(201);
    const { id } = await issueRes.json();
    createdIssueIds.push(id);
    return id;
  }

  /**
   * Open the CreateWorkspaceForm with the LaunchPreviewPanel for the given issue.
   *
   * Navigation path:
   *   1. Click issue card → IssueDetailPanel opens
   *   2. Click "Custom options..." link in the Workspaces section → WorkspacePanel opens
   *   3. Click "New Workspace" button in the WorkspacePanel → CreateWorkspaceForm appears
   */
  async function openNewWorkspaceForm(
    page: Parameters<Parameters<typeof test>[1]>[0]["page"],
    issueTitle: string,
  ) {
    // Click the issue card title to open the detail panel
    const issueCardTitle = page.locator("p", { hasText: issueTitle }).first();
    await expect(issueCardTitle, `Issue card "${issueTitle}" must be visible`).toBeVisible({
      timeout: 10_000,
    });
    await issueCardTitle.click();

    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible({
      timeout: 5_000,
    });

    // "Custom options..." opens the WorkspacePanel where the form lives.
    // For issues with an existing workspace it becomes "View Workspaces".
    const customOrViewBtn = page
      .locator("button", { hasText: "Custom options..." })
      .or(page.locator("button", { hasText: "View Workspaces" }))
      .first();
    await expect(customOrViewBtn).toBeVisible({ timeout: 5_000 });
    await customOrViewBtn.click();

    // WorkspacePanel is now visible — find the "New Workspace" button (text may be "+ New Workspace")
    const newWorkspaceBtn = page
      .locator("button", { hasText: /New Workspace/ })
      .first();
    await expect(newWorkspaceBtn).toBeVisible({ timeout: 5_000 });
    await newWorkspaceBtn.click();

    // Branch name input signals the create form is open
    await expect(
      page.locator('input[placeholder*="feature"]').first(),
    ).toBeVisible({ timeout: 5_000 });
  }

  test("preview renders resolved branch, base branch, and provider details", async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);

    const suffix = `prev-${Date.now().toString(36)}`;
    const issueTitle = `[E2E] launch preview ${suffix}`;
    await createIssue(issueTitle, request);

    await page.goto("/");
    await page.waitForSelector(".board-columns-scroll h2");

    await openNewWorkspaceForm(page, issueTitle);

    // The launch preview panel appears after a short debounce (300 ms)
    // Wait for the "Launch Preview" label to confirm the panel has rendered
    const previewPanel = page.locator("text=Launch Preview").first();
    await expect(previewPanel).toBeVisible({ timeout: 8_000 });

    // Branch row — value is rendered in monospace text by PreviewRow
    // The suggested branch is auto-generated so we just verify "Branch" label is present
    const branchLabel = page.locator("text=Branch").first();
    await expect(branchLabel).toBeVisible({ timeout: 5_000 });

    // Base row
    const baseLabel = page.locator("text=Base").first();
    await expect(baseLabel).toBeVisible({ timeout: 5_000 });

    // Provider row should show "Claude Code" (default provider)
    const providerLabel = page.locator("text=Provider").first();
    await expect(providerLabel).toBeVisible({ timeout: 5_000 });

    const providerValue = page.locator("text=Claude Code").first();
    await expect(providerValue).toBeVisible({ timeout: 5_000 });
  });

  test("preview shows warning when an active workspace already exists for the issue", async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);

    const suffix = `warn-${Date.now().toString(36)}`;
    const issueTitle = `[E2E] preview warning ${suffix}`;
    const issueId = await createIssue(issueTitle, request);

    // Create an existing active workspace for the same issue to trigger the warning
    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: {
        issueId,
        branch: `feature/e2e-preview-existing-${suffix}`,
        requiresReview: false,
      },
    });
    expect(wsRes.status(), "POST /api/workspaces must succeed").toBe(201);
    const existingWs = await wsRes.json();
    createdWorkspaceIds.push(existingWs.id);

    await page.goto("/");
    await page.waitForSelector(".board-columns-scroll h2");

    await openNewWorkspaceForm(page, issueTitle);

    // Wait for the preview panel to load
    const previewPanel = page.locator("text=Launch Preview").first();
    await expect(previewPanel).toBeVisible({ timeout: 8_000 });

    // Warning text matches server message:
    // "Issue already has N active workspace(s): ... Multiple concurrent workspaces..."
    const warningText = page.locator("text=/active workspace/i").first();
    await expect(warningText, "Warning about existing active workspace must appear").toBeVisible({
      timeout: 10_000,
    });
  });
});
