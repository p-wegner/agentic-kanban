import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Workspace panel info: baseBranch and skill name", () => {
  let projectId: string;
  let todoStatusId: string;
  let defaultBranch: string;
  const createdWorkspaceIds: string[] = [];
  const createdIssueIds: string[] = [];
  const createdSkillIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    // Use the active project (set by global-setup) — this is what the UI shows
    const prefRes = await request.get(`${SERVER_URL}/api/preferences/active-project`);
    const pref = await prefRes.json();

    const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
    const projects = await projectsRes.json();

    const activeProject = pref.projectId
      ? (projects.find((p: { id: string }) => p.id === pref.projectId) ?? projects[0])
      : projects[0];

    projectId = activeProject.id;
    defaultBranch = activeProject.defaultBranch ?? "main";

    const statusesRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/statuses`);
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
    for (const id of createdSkillIds) {
      await request.delete(`${SERVER_URL}/api/agent-skills/${id}`);
    }
  });

  async function openWorkspacePanel(page: import("@playwright/test").Page, issueTitle: string) {
    // Find and click the issue card (force to bypass hover overlay).
    // The issue may have been auto-moved to "In Progress" when the workspace was created.
    const card = page.locator("p", { hasText: issueTitle }).first();
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.click({ force: true });

    await expect(page.locator("h2", { hasText: "Issue Details" })).toBeVisible();

    const wsLabel = page.locator("label", { hasText: "Workspaces" });
    const wsSection = wsLabel.locator("..");
    await wsSection.locator("button").first().click();

    // WorkspacePanel opens with the issue title as its h2 heading
    await expect(page.locator("h2", { hasText: issueTitle })).toBeVisible({ timeout: 5000 });
  }

  test("non-default baseBranch is shown in workspace card", async ({ page, request }) => {
    const suffix = Date.now().toString(36);

    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `BaseBranchTest ${suffix}`, statusId: todoStatusId, projectId },
    });
    const issueId = (await issueRes.json()).id;
    createdIssueIds.push(issueId);

    // Use a non-default baseBranch value. Even if git worktree creation fails,
    // the server saves the workspace record with the baseBranch stored (see catch block).
    const customBaseBranch = `test-base-${suffix}`;
    const branchName = `feature/base-branch-test-${suffix}`;
    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId, branch: branchName, baseBranch: customBaseBranch, skipSetup: true },
    });
    // Server returns 201 regardless (workspace record saved even on worktree failure)
    expect(wsRes.status()).toBe(201);
    const workspace = await wsRes.json();
    createdWorkspaceIds.push(workspace.id);

    await page.goto("/");
    await page.waitForSelector('[class*="bg-gray-100"]');

    await openWorkspacePanel(page, `BaseBranchTest ${suffix}`);

    // The workspace card shows the baseBranch badge when it differs from project default
    await expect(
      page.locator("[data-testid='workspace-base-branch']"),
    ).toBeVisible({ timeout: 5000 });

    await expect(
      page.locator("[data-testid='workspace-base-branch']"),
    ).toContainText(customBaseBranch);
  });

  test("skill name is shown in workspace card when workspace is created with a skill", async ({ page, request }) => {
    const suffix = Date.now().toString(36);

    // Create a custom skill to use
    const skillRes = await request.post(`${SERVER_URL}/api/agent-skills`, {
      data: {
        name: `test-skill-${suffix}`,
        description: "E2E test skill",
        prompt: "# Test Skill\nDo nothing.",
        projectId,
      },
    });
    const skill = await skillRes.json();
    createdSkillIds.push(skill.id);

    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `SkillNameTest ${suffix}`, statusId: todoStatusId, projectId },
    });
    const issueId = (await issueRes.json()).id;
    createdIssueIds.push(issueId);

    // Use default baseBranch so worktree creation succeeds and skillId is stored in DB
    const branchName = `feature/skill-name-test-${suffix}`;
    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId, branch: branchName, skillId: skill.id, skipSetup: true },
    });
    expect(wsRes.status()).toBe(201);
    const workspace = await wsRes.json();
    createdWorkspaceIds.push(workspace.id);

    await page.goto("/");
    await page.waitForSelector('[class*="bg-gray-100"]');

    await openWorkspacePanel(page, `SkillNameTest ${suffix}`);

    // The workspace card should show the humanized skill name badge
    await expect(
      page.locator("[data-testid='workspace-skill-name']"),
    ).toBeVisible({ timeout: 5000 });

    // "test-skill-<suffix>" humanizes to "Test Skill <suffix>"
    await expect(
      page.locator("[data-testid='workspace-skill-name']"),
    ).toContainText("Test Skill");
  });
});
