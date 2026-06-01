import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER_URL } from "../helpers/port.js";

interface Project {
  id: string;
  name: string;
  repoPath: string;
}

interface Status {
  id: string;
  name: string;
}

test.describe("Active project recovery and hydration", () => {
  const suffix = Date.now().toString(36);
  const projectAName = `active-project-hydration-a-${suffix}`;
  const projectBName = `active-project-hydration-b-${suffix}`;
  const projectAColumn = `Hydration A ${suffix}`;
  const projectBColumn = `Hydration B ${suffix}`;
  const projectAIssueTitle = `Project A hydration issue ${suffix}`;
  const projectBIssueTitle = `Project B hydration issue ${suffix}`;
  const createdIssueIds: string[] = [];
  const createdProjectIds: string[] = [];
  const tempDirs: string[] = [];
  const createdStatusIds: Array<{ projectId: string; statusId: string }> = [];
  let originalActiveProjectId: string | null = null;
  let projectAId: string;
  let projectBId: string;

  function createGitRepo(prefix: string) {
    // Project registration validates git metadata; these disposable repos are removed in afterAll.
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    execSync("git init", { cwd: dir, stdio: "pipe" });
    execSync("git config user.email test@test.com", { cwd: dir, stdio: "pipe" });
    execSync("git config user.name Test", { cwd: dir, stdio: "pipe" });
    return dir;
  }

  async function getActiveProjectId(request: APIRequestContext) {
    const res = await request.get(`${SERVER_URL}/api/preferences/active-project`);
    expect(res.ok(), `GET active-project failed with ${res.status()}`).toBe(true);
    const body: { projectId?: string | null } = await res.json();
    return body.projectId ?? null;
  }

  async function setActiveProject(request: APIRequestContext, projectId: string | null) {
    const res = await request.put(`${SERVER_URL}/api/preferences/active-project`, {
      data: projectId ? { projectId } : {},
    });
    expect(res.ok(), `PUT active-project failed with ${res.status()}`).toBe(true);
  }

  async function createProject(request: APIRequestContext, name: string) {
    const repoPath = createGitRepo(`${name}-`);
    const res = await request.post(`${SERVER_URL}/api/projects`, {
      data: { name, repoPath },
    });
    expect(res.status(), `POST project failed with ${res.status()}`).toBe(201);
    const project: Project = await res.json();
    createdProjectIds.push(project.id);
    return project.id;
  }

  async function createStatus(request: APIRequestContext, projectId: string, name: string) {
    const statusesRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/statuses`);
    expect(statusesRes.ok(), `GET statuses failed with ${statusesRes.status()}`).toBe(true);
    const statuses: Status[] = await statusesRes.json();

    const res = await request.post(`${SERVER_URL}/api/projects/${projectId}/statuses`, {
      data: { name, sortOrder: statuses.length + 20 },
    });
    expect(res.status(), `POST status failed with ${res.status()}`).toBe(201);
    const status: Status = await res.json();
    createdStatusIds.push({ projectId, statusId: status.id });
    return status.id;
  }

  async function createIssue(
    request: APIRequestContext,
    projectId: string,
    statusId: string,
    title: string,
  ) {
    const res = await request.post(`${SERVER_URL}/api/issues`, {
      data: { projectId, statusId, title },
    });
    expect(res.status(), `POST issue failed with ${res.status()}`).toBe(201);
    const issue: { id: string } = await res.json();
    createdIssueIds.push(issue.id);
  }

  async function waitForBoardColumn(page: Page, name: string) {
    await expect(page.locator("h2", { hasText: name })).toBeVisible({ timeout: 10_000 });
  }

  async function waitForBoardContent(page: Page, columnName: string, issueTitle: string) {
    await waitForBoardColumn(page, columnName);
    await expect(page.locator("p", { hasText: issueTitle })).toBeVisible({ timeout: 10_000 });
  }

  async function switchProject(page: Page, projectId: string) {
    const projectSelect = page.locator("header select");
    await expect(projectSelect).toBeVisible({ timeout: 5_000 });
    await projectSelect.selectOption(projectId);
    await expect(projectSelect).toHaveValue(projectId, { timeout: 5_000 });
  }

  test.beforeAll(async ({ request }) => {
    originalActiveProjectId = await getActiveProjectId(request);
    projectAId = await createProject(request, projectAName);
    projectBId = await createProject(request, projectBName);

    const projectAStatusId = await createStatus(request, projectAId, projectAColumn);
    const projectBStatusId = await createStatus(request, projectBId, projectBColumn);
    await createIssue(request, projectAId, projectAStatusId, projectAIssueTitle);
    await createIssue(request, projectBId, projectBStatusId, projectBIssueTitle);
  });

  test.afterAll(async ({ request }) => {
    await setActiveProject(request, originalActiveProjectId).catch(() => {});

    for (const issueId of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${issueId}`).catch(() => {});
    }

    for (const { projectId, statusId } of createdStatusIds) {
      await request.delete(`${SERVER_URL}/api/projects/${projectId}/statuses/${statusId}`).catch(() => {});
    }

    for (const projectId of createdProjectIds) {
      await request.delete(`${SERVER_URL}/api/projects/${projectId}`).catch(() => {});
    }

    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recovers from stale active project and hydrates after project switches and reloads", async ({
    page,
    request,
  }) => {
    // This intentionally stores a stale active-project value through the public API.
    // The test uses SERVER_URL/page.goto baseURL, both configured for 127.0.0.1.
    await setActiveProject(request, `stale-project-${suffix}`);

    const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
    expect(projectsRes.ok(), `GET projects failed with ${projectsRes.status()}`).toBe(true);
    const projects: Project[] = await projectsRes.json();
    const [recoveredProject] = projects;
    expect(recoveredProject, "Expected at least one registered project for active-project fallback").toBeTruthy();

    const statusesRes = await request.get(`${SERVER_URL}/api/projects/${recoveredProject.id}/statuses`);
    expect(statusesRes.ok(), `GET recovered statuses failed with ${statusesRes.status()}`).toBe(true);
    const recoveredStatuses: Status[] = await statusesRes.json();
    expect(recoveredStatuses.length, "Recovered project should have board columns").toBeGreaterThan(0);

    await page.goto("/");

    await waitForBoardColumn(page, recoveredStatuses[0].name);
    const projectSelect = page.locator("header select");
    await expect(projectSelect).toHaveValue(recoveredProject.id, { timeout: 5_000 });

    await switchProject(page, projectAId);
    await waitForBoardContent(page, projectAColumn, projectAIssueTitle);
    await expect(page.locator("h2", { hasText: projectBColumn })).not.toBeVisible();

    await page.reload();
    await waitForBoardContent(page, projectAColumn, projectAIssueTitle);
    await expect(projectSelect).toHaveValue(projectAId, { timeout: 5_000 });

    await switchProject(page, projectBId);
    await waitForBoardContent(page, projectBColumn, projectBIssueTitle);
    await expect(page.locator("h2", { hasText: projectAColumn })).not.toBeVisible();

    await page.reload();
    await waitForBoardContent(page, projectBColumn, projectBIssueTitle);
    await expect(projectSelect).toHaveValue(projectBId, { timeout: 5_000 });
  });
});
