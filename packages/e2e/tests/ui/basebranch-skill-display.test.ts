/**
 * E2E tests for baseBranch label and skill name display in the workspace panel.
 *
 * Strategy: create workspaces via API (mock agent), navigate to the board,
 * click the issue card → open IssueDetailPanel → click "View Workspaces" →
 * assert data-testid badges appear in the WorkspacePanel.
 */
import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("baseBranch and skill name display in workspace panel", () => {
  let projectId: string;
  let todoStatusId: string;
  let defaultBranch: string;
  const createdIssueIds: string[] = [];
  const createdWorkspaceIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
    const projects = await projectsRes.json();
    projectId = projects[0].id;
    defaultBranch = projects[0].defaultBranch;

    await request.put(`${SERVER_URL}/api/preferences/active-project`, {
      data: { projectId },
    });

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    const statuses = await statusesRes.json();
    todoStatusId = statuses.find((s: { name: string }) => s.name === "Todo").id;

    // Enable mock agent so workspace creation does not launch real agent
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
  ) {
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title,
        statusId: todoStatusId,
        projectId,
        skipAutoReview: true,
      },
    });
    expect(issueRes.status()).toBe(201);
    const { id: issueId } = await issueRes.json();
    createdIssueIds.push(issueId);
    return issueId;
  }

  async function createWorkspace(
    issueId: string,
    branchSuffix: string,
    opts: { baseBranch?: string; skillId?: string } = {},
    request: Parameters<Parameters<typeof test>[1]>[0]["request"],
  ) {
    const body: Record<string, unknown> = {
      issueId,
      branch: `feature/e2e-bbs-${branchSuffix}`,
      requiresReview: false,
    };
    if (opts.baseBranch) body.baseBranch = opts.baseBranch;
    if (opts.skillId) body.skillId = opts.skillId;

    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, { data: body });
    // 201 even if worktree fails — workspace record is still created with baseBranch/skillName stored
    expect(wsRes.status()).toBe(201);
    const ws = await wsRes.json();
    createdWorkspaceIds.push(ws.id);
    return ws;
  }

  /** Hover over the issue card and click the "Resume" button to open WorkspacePanel directly. */
  async function openWorkspacePanel(
    page: Parameters<Parameters<typeof test>[1]>[0]["page"],
    issueTitle: string,
    _branchSuffix: string,
  ) {
    const issueCard = page.locator("p", { hasText: issueTitle }).first();
    await expect(issueCard).toBeVisible({ timeout: 10_000 });

    // Hover the card to reveal the action row (Resume button has opacity-0 → opacity-100 on hover)
    // p → div.flex.items-start → div.group.bg-white (the card)
    const cardContainer = issueCard.locator("xpath=../..");
    await cardContainer.hover();

    // The Resume button directly opens the WorkspacePanel without going through IssueDetailPanel
    const resumeBtn = cardContainer.getByRole("button", { name: /Resume/i });
    await expect(resumeBtn).toBeVisible({ timeout: 5_000 });
    await resumeBtn.click();

    // Wait for the WorkspacePanel to appear (it has data-panel="true")
    await expect(page.locator('[data-panel="true"]')).toBeVisible({ timeout: 5_000 });
  }

  test("non-default baseBranch label appears in workspace panel", async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);

    const suffix = `bb-${Date.now().toString(36)}`;
    const issueTitle = `[E2E] baseBranch display ${suffix}`;

    const issueId = await createIssue(issueTitle, request);

    // Use a branch that exists in the repo but differs from the project default branch
    const nonDefaultBranch = "debug/anth-test";
    await createWorkspace(issueId, suffix, { baseBranch: nonDefaultBranch }, request);

    await page.goto("/");
    await page.waitForSelector(".board-columns-scroll h2");
    await openWorkspacePanel(page, issueTitle, suffix);

    // The baseBranch badge has data-testid="workspace-base-branch"
    const baseBranchBadge = page.locator('[data-testid="workspace-base-branch"]').first();
    await expect(baseBranchBadge).toBeVisible({ timeout: 10_000 });
    await expect(baseBranchBadge).toContainText(nonDefaultBranch);
  });

  test("skill name badge appears in workspace panel when workspace was started with a skill", async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);

    // Fetch the code-review skill id (builtin, always present)
    const skillsRes = await request.get(`${SERVER_URL}/api/agent-skills`);
    const skills = await skillsRes.json();
    const codeReviewSkill = skills.find((s: { name: string }) => s.name === "code-review");
    expect(codeReviewSkill).toBeTruthy();

    const suffix = `sk-${Date.now().toString(36)}`;
    const issueTitle = `[E2E] skill display ${suffix}`;

    const issueId = await createIssue(issueTitle, request);
    await createWorkspace(issueId, suffix, { skillId: codeReviewSkill.id }, request);

    await page.goto("/");
    await page.waitForSelector(".board-columns-scroll h2");
    await openWorkspacePanel(page, issueTitle, suffix);

    // The skill name badge has data-testid="workspace-skill-name"
    const skillBadge = page.locator('[data-testid="workspace-skill-name"]').first();
    await expect(skillBadge).toBeVisible({ timeout: 10_000 });
    // humanizeSkillName("code-review") => "Code Review"
    await expect(skillBadge).toContainText("Code Review");
  });

  test("default baseBranch does not show the baseBranch badge", async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);

    const suffix = `def-${Date.now().toString(36)}`;
    const issueTitle = `[E2E] default baseBranch no badge ${suffix}`;

    const issueId = await createIssue(issueTitle, request);
    // No baseBranch provided — server defaults to project defaultBranch
    await createWorkspace(issueId, suffix, {}, request);

    await page.goto("/");
    await page.waitForSelector(".board-columns-scroll h2");
    await openWorkspacePanel(page, issueTitle, suffix);

    // Badge should NOT appear because baseBranch equals defaultBranch
    const baseBranchBadge = page.locator('[data-testid="workspace-base-branch"]').first();
    await expect(baseBranchBadge).toHaveCount(0);
  });
});
