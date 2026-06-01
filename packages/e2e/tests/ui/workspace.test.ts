import {
  test,
  expect,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
} from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

async function describeResponse(response: APIResponse) {
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "<body unavailable>";
  }

  const trimmedBody = body.length > 500 ? `${body.slice(0, 500)}...` : body;
  return `${response.status()} ${response.statusText()} ${trimmedBody}`;
}

async function expectJson<T>(response: APIResponse, label: string): Promise<T> {
  if (!response.ok()) {
    throw new Error(`${label} failed: ${await describeResponse(response)}`);
  }

  return (await response.json()) as T;
}

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
    const projects = await expectJson<Array<{ id: string }>>(
      projectsRes,
      "GET /api/projects",
    );
    expect(projects.length, "E2E server has no registered projects").toBeGreaterThan(
      0,
    );

    const activeProjectRes = await request.get(
      `${SERVER_URL}/api/preferences/active-project`,
    );
    if (activeProjectRes.ok()) {
      const activeProject = await activeProjectRes.json();
      projectId = activeProject.projectId ?? projects[0].id;
    } else {
      projectId = projects[0].id;
    }

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await expectJson<Array<{ id: string; name: string }>>(
      statusesRes,
      "GET project statuses",
    );
    expect(statuses.length, "Project has no statuses").toBeGreaterThan(0);
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

  async function setupWorkspaceWithDiagnostics(
    request: APIRequestContext,
    workspaceId: string,
  ) {
    const attempts: string[] = [];
    let attempt = 0;

    try {
      await expect
        .poll(
          async () => {
            attempt += 1;
            try {
              const setupRes = await request.post(
                `${SERVER_URL}/api/workspaces/${workspaceId}/setup`,
                { data: {} },
              );

              if (setupRes.ok()) {
                return "ready";
              }

              const body = await setupRes.text();
              attempts.push(
                `attempt ${attempt}: HTTP ${setupRes.status()} ${body.slice(0, 500)}`,
              );
            } catch (error) {
              attempts.push(
                `attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }

            return "not-ready";
          },
          {
            timeout: 10000,
            intervals: [250, 500, 1000],
            message: `workspace ${workspaceId} setup did not become ready`,
          },
        )
        .toBe("ready");
    } catch (error) {
      const attemptLog = attempts.length > 0 ? attempts.join("\n") : "no setup attempts recorded";
      throw new Error(
        `Workspace setup failed for ${workspaceId}.\n${attemptLog}`,
        { cause: error },
      );
    }
  }

  async function openWorkspaceForIssue(
    page: Page,
    issueTitle: string,
    branchName: string,
  ) {
    const issueCardTitle = page.locator("p", { hasText: issueTitle }).first();
    await expect(
      issueCardTitle,
      `Issue "${issueTitle}" should be visible in the active project board`,
    ).toBeVisible({ timeout: 10000 });
    await issueCardTitle.click();
    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();

    // Click the workspace button in the Workspaces section of the detail panel
    const wsLabel = page.locator("label", { hasText: "Workspaces" });
    const wsSection = wsLabel.locator("..");
    const workspaceButton = wsSection
      .locator("button", { hasText: branchName })
      .or(wsSection.locator("button", { hasText: "View Workspaces" }))
      .first();
    await expect(
      workspaceButton,
      `Issue "${issueTitle}" should expose workspace "${branchName}"`,
    ).toBeVisible({ timeout: 10000 });
    await workspaceButton.click();

    // Workspace panel should be visible
    await expect(page.locator("h2", { hasText: issueTitle })).toBeVisible({
      timeout: 5000,
    });

    // Close the issue detail panel that otherwise sits above the workspace panel.
    const issueDetailsHeading = page.locator("h2", { hasText: "Issue Details" });
    if (await issueDetailsHeading.isVisible()) {
      const issueDetailPanel = page
        .locator("[data-panel]", { has: issueDetailsHeading })
        .first();
      await issueDetailPanel.locator("button", { hasText: "×" }).first().click();
      await expect(issueDetailsHeading).toBeHidden({ timeout: 5000 });
    }

    const panel = workspacePanel(page, issueTitle);
    await expect(panel.locator(`text=${branchName}`).first()).toBeVisible({
      timeout: 15000,
    });

    const card = workspaceCard(page, issueTitle, branchName);
    const actionButton = card
      .locator("button", { hasText: "View Diff" })
      .or(card.locator("button", { hasText: "Merge" }))
      .first();
    if (!(await actionButton.isVisible())) {
      await card.click();
      await expect(actionButton).toBeVisible({ timeout: 10000 });
    }
  }

  function workspacePanel(page: Page, issueTitle: string): Locator {
    return page
      .locator("[data-panel]", { has: page.locator("h2", { hasText: issueTitle }) })
      .first();
  }

  function workspaceCard(page: Page, issueTitle: string, branchName: string): Locator {
    return workspacePanel(page, issueTitle)
      .locator(".cursor-pointer", { hasText: branchName })
      .first();
  }

  function workspaceActionButton(
    page: Page,
    issueTitle: string,
    branchName: string,
    name: string,
  ) {
    return workspaceCard(page, issueTitle, branchName)
      .locator("button", { hasText: name })
      .first();
  }

  test("View Diff button shows diff output in panel", async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `DiffTestIssue ${suffix}`, statusId: todoStatusId, projectId },
    });
    const issueId = (await expectJson<{ id: string }>(
      issueRes,
      "POST /api/issues",
    )).id;
    createdIssueIds.push(issueId);

    const branchName = `feature/diff-test-${suffix}`;
    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId, branch: branchName },
    });
    const workspace = await expectJson<{ id: string }>(
      wsRes,
      "POST /api/workspaces",
    );
    const workspaceId = workspace.id;
    createdWorkspaceIds.push(workspaceId);

    await setupWorkspaceWithDiagnostics(request, workspaceId);

    await page.goto("/");
    await page.waitForSelector("h2");

    const issueTitle = `DiffTestIssue ${suffix}`;
    await openWorkspaceForIssue(page, issueTitle, branchName);

    // Should see "View Diff" button
    const viewDiffButton = workspaceActionButton(
      page,
      issueTitle,
      branchName,
      "View Diff",
    );
    await expect(viewDiffButton).toBeVisible({ timeout: 5000 });

    // Click View Diff
    await viewDiffButton.click();

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
    const issueId = (await expectJson<{ id: string }>(
      issueRes,
      "POST /api/issues",
    )).id;
    createdIssueIds.push(issueId);

    const branchName = `feature/merge-test-${suffix}`;
    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId, branch: branchName },
    });
    const workspace = await expectJson<{ id: string }>(
      wsRes,
      "POST /api/workspaces",
    );
    const workspaceId = workspace.id;
    createdWorkspaceIds.push(workspaceId);

    await setupWorkspaceWithDiagnostics(request, workspaceId);

    await page.goto("/");
    await page.waitForSelector("h2");

    const issueTitle = `MergeTestIssue ${suffix}`;
    await openWorkspaceForIssue(page, issueTitle, branchName);

    // Should see "Merge" button
    const mergeButton = workspaceActionButton(
      page,
      issueTitle,
      branchName,
      "Merge",
    );
    await expect(mergeButton).toBeVisible({ timeout: 5000 });

    // Click Merge
    await mergeButton.click();

    // Wait for merge to complete — the workspace status should change to "closed" or "merged"
    await expect(
      page.locator("text=closed").or(page.locator("text=merged")).first(),
    ).toBeVisible({ timeout: 15000 });
  });
});
