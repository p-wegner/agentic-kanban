import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { SERVER_URL } from "../helpers/port.js";

test.describe("Worktrees API", () => {
  let projectId: string;
  let projectRepoPath: string;
  let statusId: string;
  const createdIssueIds: string[] = [];
  const createdWorkspaceIds: string[] = [];
  const suffix = Date.now().toString(36);

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
    const projects = await projectsRes.json();
    projectId = projects[0].id;
    projectRepoPath = projects[0].repoPath;

    const statusesRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/statuses`);
    const statuses = await statusesRes.json();
    const todoStatus = statuses.find((s: { name: string }) => s.name === "Todo");
    statusId = todoStatus ? todoStatus.id : statuses[0].id;
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`);
    }
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`);
    }
  });

  test("GET /api/projects/:id/worktrees returns main worktree", async ({ request }) => {
    const res = await request.get(`${SERVER_URL}/api/projects/${projectId}/worktrees`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);

    const main = body.find((wt: { isMain: boolean }) => wt.isMain);
    expect(main).toBeDefined();
    expect(main.path).toBeDefined();
    expect(main.branch).toBeDefined();
  });

  test("GET /api/projects/:id/worktrees marks orphaned worktrees (no workspace)", async ({ request }) => {
    // Create a workspace so we have a real worktree, then delete the workspace record
    // to produce an orphaned worktree
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `Orphan test issue ${suffix}`, statusId, projectId },
    });
    expect(issueRes.status()).toBe(201);
    const issueId = (await issueRes.json()).id;
    createdIssueIds.push(issueId);

    const branchName = `feature/orphan-test-${suffix}`;
    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId, branch: branchName },
    });
    expect(wsRes.status()).toBe(201);
    const workspace = await wsRes.json();
    const workspaceId = workspace.id;
    // Do NOT push to createdWorkspaceIds since we'll delete it manually below

    // Delete workspace record — leaves git worktree on disk (orphaned)
    const delRes = await request.delete(`${SERVER_URL}/api/workspaces/${workspaceId}`);
    expect(delRes.ok()).toBeTruthy();

    // List worktrees — the leftover git worktree should appear without a workspace
    const listRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/worktrees`);
    expect(listRes.ok()).toBeTruthy();
    const worktrees = await listRes.json();

    const orphan = worktrees.find(
      (wt: { branch: string; workspace?: unknown }) => wt.branch === branchName && !wt.workspace,
    );
    expect(orphan).toBeDefined();

    // Clean up: remove the orphaned worktree via DELETE
    const cleanRes = await request.delete(`${SERVER_URL}/api/projects/${projectId}/worktrees`, {
      data: { path: orphan.path },
    });
    expect(cleanRes.ok()).toBeTruthy();
  });

  test("DELETE /api/projects/:id/worktrees removes orphaned worktree directory", async ({ request }) => {
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `Orphan delete test ${suffix}`, statusId, projectId },
    });
    expect(issueRes.status()).toBe(201);
    const issueId = (await issueRes.json()).id;
    createdIssueIds.push(issueId);

    const branchName = `feature/orphan-del-${suffix}`;
    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId, branch: branchName },
    });
    expect(wsRes.status()).toBe(201);
    const workspace = await wsRes.json();
    const workingDir: string | null = workspace.workingDir;

    // Delete workspace record to orphan the worktree
    await request.delete(`${SERVER_URL}/api/workspaces/${workspace.id}`);

    // Confirm directory exists before we clean it
    if (workingDir) {
      expect(existsSync(workingDir)).toBe(true);
    }

    // Get orphan path from API
    const listRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/worktrees`);
    const worktrees = await listRes.json();
    const orphan = worktrees.find(
      (wt: { branch: string; workspace?: unknown }) => wt.branch === branchName && !wt.workspace,
    );
    expect(orphan).toBeDefined();

    // Delete the orphaned worktree
    const delRes = await request.delete(`${SERVER_URL}/api/projects/${projectId}/worktrees`, {
      data: { path: orphan.path },
    });
    expect(delRes.ok()).toBeTruthy();
    const body = await delRes.json();
    expect(body.success).toBe(true);

    // Directory should be gone
    if (workingDir) {
      expect(existsSync(workingDir)).toBe(false);
    }

    // Should no longer appear in list
    const afterRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/worktrees`);
    const afterList = await afterRes.json();
    const stillPresent = afterList.find(
      (wt: { branch: string }) => wt.branch === branchName,
    );
    expect(stillPresent).toBeUndefined();
  });

  test("DELETE /api/projects/:id/worktrees with workspaceId cascades workspace data", async ({ request }) => {
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `Cascade delete test ${suffix}`, statusId, projectId },
    });
    expect(issueRes.status()).toBe(201);
    const issueId = (await issueRes.json()).id;
    createdIssueIds.push(issueId);

    const branchName = `feature/cascade-del-${suffix}`;
    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId, branch: branchName },
    });
    expect(wsRes.status()).toBe(201);
    const workspace = await wsRes.json();
    const workspaceId = workspace.id;

    // Delete via worktrees endpoint with workspaceId — should cascade-delete workspace too
    const delRes = await request.delete(`${SERVER_URL}/api/projects/${projectId}/worktrees`, {
      data: { path: workspace.workingDir, workspaceId },
    });
    expect(delRes.ok()).toBeTruthy();

    // Workspace should be gone
    const wsCheckRes = await request.get(`${SERVER_URL}/api/workspaces/${workspaceId}`);
    expect(wsCheckRes.status()).toBe(404);
  });

  test("DELETE /api/projects/:id/worktrees returns 400 with no path or workspaceId", async ({ request }) => {
    const res = await request.delete(`${SERVER_URL}/api/projects/${projectId}/worktrees`, {
      data: {},
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});
