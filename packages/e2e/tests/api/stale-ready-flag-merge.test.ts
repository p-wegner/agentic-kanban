/**
 * Regression test for AK-597: workspace readyForMerge=true should not cause a
 * perpetual 409 when master advances after the flag is set.
 *
 * Scenario:
 *   1. Create a workspace; commit a non-conflicting file change on its branch.
 *   2. Mark the workspace readyForMerge=true.
 *   3. Advance master with a non-conflicting commit (different file).
 *   4. Call POST /merge — assert it succeeds (200) and the issue reaches Done.
 *
 * Previously (before the fix) the merge endpoint would either 409 immediately
 * because detectConflicts saw the branch behind base, or the mergeBranch step
 * would fail — leaving the board churning on a doomed retry loop.
 */

import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProject } from "../helpers/e2e-project.js";

test.describe("stale readyForMerge flag: merge succeeds after master advances", () => {
  let projectId: string;
  let projectRepoPath: string;
  let defaultBranch: string;
  let todoStatusId: string;
  let doneStatusId: string;
  let issueId: string;
  let issueNumber: number;
  let workspaceId: string;
  let workingDir: string;
  let originalClaudeProfile = "";
  const suffix = Date.now().toString(36);

  test.beforeAll(async ({ request }) => {
    const project = await getE2EProject(request);
    projectId = project.id;
    projectRepoPath = project.repoPath;
    defaultBranch = project.defaultBranch ?? "master";

    const statusesRes = await request.get(`${SERVER_URL}/api/projects/${projectId}/statuses`);
    expect(statusesRes.ok()).toBeTruthy();
    const statuses: Array<{ id: string; name: string }> = await statusesRes.json();

    const todoStatus = statuses.find((s) => s.name === "Todo");
    todoStatusId = todoStatus ? todoStatus.id : statuses[0].id;
    const doneStatus = statuses.find((s) => s.name === "Done");
    doneStatusId = doneStatus ? doneStatus.id : statuses[statuses.length - 1].id;

    const settingsRes = await request.get(`${SERVER_URL}/api/preferences/settings`);
    if (settingsRes.ok()) {
      const s = await settingsRes.json();
      originalClaudeProfile = s.claude_profile ?? "";
    }
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { claude_profile: "mock" },
    });

    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title: `Stale-ready-flag test ${suffix}`, statusId: todoStatusId, projectId, skipAutoReview: true },
    });
    expect(issueRes.status()).toBe(201);
    const issue = await issueRes.json();
    issueId = issue.id;
    issueNumber = issue.issueNumber;

    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId, branch: `feature/stale-ready-test-${suffix}` },
    });
    expect(wsRes.status()).toBe(201);
    const ws = await wsRes.json();
    workspaceId = ws.id;
    workingDir = ws.workingDir;
    expect(workingDir, "workspace must have a workingDir").toBeTruthy();

    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`).catch(() => {});

    // Step 1: commit a change on the feature branch (unique file so no overlap with master advance)
    execSync("git config user.email e2e@test.local", { cwd: workingDir });
    execSync("git config user.name E2ETest", { cwd: workingDir });
    writeFileSync(join(workingDir, `e2e-feature-${suffix}.txt`), `feature change ${suffix}\n`);
    execSync("git add -A", { cwd: workingDir });
    execSync(`git commit -m "e2e: feature commit for stale-ready-flag test ${suffix}"`, { cwd: workingDir });

    // Step 2: mark readyForMerge=true
    const readyRes = await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/ready-for-merge`);
    expect(readyRes.ok(), "mark ready-for-merge must succeed").toBeTruthy();

    // Step 3: advance master with a non-conflicting commit (different file)
    execSync("git config user.email e2e@test.local", { cwd: projectRepoPath });
    execSync("git config user.name E2ETest", { cwd: projectRepoPath });
    writeFileSync(join(projectRepoPath, `e2e-master-advance-${suffix}.txt`), `master advance ${suffix}\n`);
    execSync("git add -A", { cwd: projectRepoPath });
    execSync(`git commit -m "e2e: master advance for stale-ready-flag test ${suffix}"`, { cwd: projectRepoPath });
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`${SERVER_URL}/api/workspaces/${workspaceId}`).catch(() => {});
    await request.delete(`${SERVER_URL}/api/issues/${issueId}`).catch(() => {});
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { claude_profile: originalClaudeProfile },
    }).catch(() => {});
    // Remove the master-advance marker from master so it doesn't leak between tests
    try {
      execSync(`git rm -f e2e-master-advance-${suffix}.txt`, { cwd: projectRepoPath, stdio: "pipe" });
      execSync(`git commit -m "e2e: cleanup stale-ready-flag marker"`, { cwd: projectRepoPath, stdio: "pipe" });
    } catch { /* best-effort */ }
  });

  async function pollUntil<T>(
    fn: () => Promise<T | null | undefined | false>,
    opts: { attempts?: number; delayMs?: number; label?: string } = {},
  ): Promise<T> {
    const { attempts = 20, delayMs = 500, label = "condition" } = opts;
    for (let i = 0; i < attempts; i++) {
      const result = await fn();
      if (result) return result as T;
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error(`[pollUntil] Timed out waiting for ${label}`);
  }

  test("merge succeeds even when master advanced after readyForMerge was set", async ({ request }) => {
    test.setTimeout(90_000);

    // Verify the workspace is behind base before we attempt the merge
    const wsBefore = await request.get(`${SERVER_URL}/api/workspaces/${workspaceId}`);
    expect(wsBefore.ok()).toBeTruthy();
    const wsBody = await wsBefore.json();
    expect(wsBody.readyForMerge, "readyForMerge must still be true").toBe(true);

    // POST /merge — must not 409 just because master advanced with a non-conflicting commit
    const mergeRes = await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/merge`);
    expect(mergeRes.status(), `POST /merge must not 409 for a non-conflicting behind-base branch (got ${mergeRes.status()})`).not.toBe(409);
    expect(mergeRes.status(), "POST /merge must not return 5xx").toBeLessThan(500);

    // Workspace must become closed
    await pollUntil(
      async () => {
        const res = await request.get(`${SERVER_URL}/api/workspaces/${workspaceId}`);
        if (!res.ok()) return null;
        const body = await res.json();
        return body.status === "closed" ? body : null;
      },
      { label: "workspace.status === closed" },
    );

    // Issue must reach Done
    await pollUntil(
      async () => {
        const res = await request.get(`${SERVER_URL}/api/issues?projectId=${projectId}&issueNumber=${issueNumber}`);
        if (!res.ok()) return null;
        const list = await res.json();
        const found = list[0];
        return found?.statusId === doneStatusId ? found : null;
      },
      { label: `issue #${issueNumber} to reach Done` },
    );
  });
});
