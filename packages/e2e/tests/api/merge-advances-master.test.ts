/**
 * E2E coverage for AK-389: POST /api/workspaces/:id/merge advances master
 * and moves the issue to Done.
 *
 * Strategy:
 *   1. Create an issue and workspace with a real committed change on the branch.
 *   2. Call the merge endpoint.
 *   3. Assert (a) master's HEAD now includes the branch commit (git log check),
 *      and (b) the issue transitioned to Done and the workspace is closed/merged.
 * The state assertions poll with a bounded retry loop instead of trusting the
 * merge HTTP response body (which can be dropped).
 *
 * Idempotency: a second merge call on the already-merged workspace must not
 * error the test (covers the already-merged-ancestor reconcile path).
 */

import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProject } from "../helpers/e2e-project.js";

test.describe("merge endpoint advances master and moves issue to Done", () => {
  let projectId: string;
  let projectRepoPath: string;
  let defaultBranch: string;
  let todoStatusId: string;
  let doneStatusId: string;
  let issueId: string;
  let issueNumber: number;
  let workspaceId: string;
  let workingDir: string;
  let branchCommitSha: string;
  const suffix = Date.now().toString(36);
  let originalClaudeProfile = "";

  test.beforeAll(async ({ request }) => {
    const project = await getE2EProject(request);
    projectId = project.id;
    projectRepoPath = project.repoPath;
    defaultBranch = project.defaultBranch ?? "master";

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    expect(statusesRes.ok(), `GET statuses returned ${statusesRes.status()}`).toBeTruthy();
    const statuses: Array<{ id: string; name: string }> = await statusesRes.json();
    expect(statuses.length, "Project must have statuses").toBeGreaterThan(0);

    const todoStatus = statuses.find((s) => s.name === "Todo");
    todoStatusId = todoStatus ? todoStatus.id : statuses[0].id;

    const doneStatus = statuses.find((s) => s.name === "Done");
    doneStatusId = doneStatus ? doneStatus.id : statuses[statuses.length - 1].id;

    // Capture current claude_profile so we can restore it in afterAll.
    const settingsRes = await request.get(`${SERVER_URL}/api/preferences/settings`);
    if (settingsRes.ok()) {
      const s = await settingsRes.json();
      originalClaudeProfile = s.claude_profile ?? "";
    }

    // Use mock profile so workspace creation does not launch a real agent.
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { claude_profile: "mock" },
    });

    // Create an issue.
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `Merge-advances-master test ${suffix}`,
        statusId: todoStatusId,
        projectId,
        skipAutoReview: true,
      },
    });
    expect(issueRes.status(), `POST /api/issues returned ${issueRes.status()}`).toBe(201);
    const issue = await issueRes.json();
    issueId = issue.id;
    issueNumber = issue.issueNumber;

    // Create a workspace (creates the git worktree).
    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: {
        issueId,
        branch: `feature/merge-master-test-${suffix}`,
      },
    });
    expect(wsRes.status(), `POST /api/workspaces returned ${wsRes.status()}`).toBe(201);
    const ws = await wsRes.json();
    workspaceId = ws.id;
    workingDir = ws.workingDir;

    expect(workingDir, "workspace must have a workingDir (worktree path)").toBeTruthy();

    // Stop any auto-launched mock agent before we commit.
    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`).catch(() => {});

    // Make a real commit in the worktree so the branch diverges from master.
    // git config must be set in case this is a fresh repo with no global config.
    execSync("git config user.email e2e@test.local", { cwd: workingDir });
    execSync("git config user.name E2ETest", { cwd: workingDir });
    const markerFile = join(workingDir, `e2e-merge-marker-${suffix}.txt`);
    writeFileSync(markerFile, `marker for merge test ${suffix}\n`);
    execSync("git add -A", { cwd: workingDir });
    execSync(`git commit -m "e2e: marker commit for merge-advances-master test ${suffix}"`, {
      cwd: workingDir,
    });

    // Capture the branch tip SHA so we can verify it lands on master later.
    branchCommitSha = execSync("git rev-parse HEAD", { cwd: workingDir })
      .toString()
      .trim();
  });

  test.afterAll(async ({ request }) => {
    // Best-effort cleanup — do not let afterAll failures mask test failures.
    await request.delete(`${SERVER_URL}/api/workspaces/${workspaceId}`).catch(() => {});
    await request.delete(`${SERVER_URL}/api/issues/${issueId}`).catch(() => {});
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { claude_profile: originalClaudeProfile },
    }).catch(() => {});
  });

  /** Poll until predicate returns a truthy value or the attempt limit is reached. */
  async function pollUntil<T>(
    fn: () => Promise<T | null | undefined | false>,
    opts: { attempts?: number; delayMs?: number; label?: string } = {},
  ): Promise<T> {
    const { attempts = 15, delayMs = 500, label = "condition" } = opts;
    for (let i = 0; i < attempts; i++) {
      const result = await fn();
      if (result) return result as T;
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error(`[pollUntil] Timed out waiting for ${label}`);
  }

  async function createCommittedWorkspace(
    label: string,
    request: Parameters<Parameters<typeof test>[1]>[0]["request"],
  ) {
    const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
      data: {
        title: `Merge-advances-master ${label} ${suffix}`,
        statusId: todoStatusId,
        projectId,
        skipAutoReview: true,
      },
    });
    expect(issueRes.status(), `POST /api/issues returned ${issueRes.status()} for ${label}`).toBe(201);
    const issue = await issueRes.json();

    const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: {
        issueId: issue.id,
        branch: `feature/merge-master-${label}-${suffix}`,
      },
    });
    expect(wsRes.status(), `POST /api/workspaces returned ${wsRes.status()} for ${label}`).toBe(201);
    const ws = await wsRes.json();

    await request.post(`${SERVER_URL}/api/workspaces/${ws.id}/stop`).catch(() => {});

    execSync("git config user.email e2e@test.local", { cwd: ws.workingDir });
    execSync("git config user.name E2ETest", { cwd: ws.workingDir });
    const markerFile = join(ws.workingDir, `e2e-merge-marker-${label}-${suffix}.txt`);
    writeFileSync(markerFile, `marker for merge ${label} ${suffix}\n`);
    execSync("git add -A", { cwd: ws.workingDir });
    execSync(`git commit -m "e2e: marker commit for merge ${label} ${suffix}"`, {
      cwd: ws.workingDir,
    });
    const branchCommitSha = execSync("git rev-parse HEAD", { cwd: ws.workingDir }).toString().trim();

    return {
      issueId: issue.id,
      issueNumber: issue.issueNumber as number,
      workspaceId: ws.id as string,
      workingDir: ws.workingDir as string,
      branchCommitSha,
      branch: `feature/merge-master-${label}-${suffix}`,
    };
  }

  async function branchDeleted(repoPath: string, branch: string): Promise<boolean> {
    try {
      execSync(`git show-ref --verify --quiet refs/heads/${branch}`, { cwd: repoPath, stdio: "pipe" });
      return false;
    } catch {
      return true;
    }
  }

  test("POST /merge closes workspace and moves issue to Done", async ({ request }) => {
    test.setTimeout(90_000);
    // Call merge — the HTTP response body may be dropped, so we only assert it
    // doesn't return a hard server error (5xx). 2xx or 4xx already-merged is fine.
    const mergeRes = await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/merge`);
    const mergeStatus = mergeRes.status();
    expect(mergeStatus, `POST /merge must not return 5xx`).toBeLessThan(500);

    // (a) Verify master now includes the branch commit — poll git in the main checkout.
    // git merge-base --is-ancestor <sha> <branch> exits 0 only when sha IS reachable
    // from branch, and exits 1 when it is not. git branch --contains does NOT do this —
    // it exits 0 regardless of whether the sha is found.
    await pollUntil(
      async () => {
        try {
          execSync(`git merge-base --is-ancestor ${branchCommitSha} ${defaultBranch}`, {
            cwd: projectRepoPath,
            stdio: "pipe",
          });
          return true;
        } catch {
          return false;
        }
      },
      { attempts: 20, delayMs: 500, label: `commit ${branchCommitSha} to appear on ${defaultBranch}` },
    );

    // (b) Verify workspace is closed.
    const ws = await pollUntil(
      async () => {
        const res = await request.get(`${SERVER_URL}/api/workspaces/${workspaceId}`);
        if (!res.ok()) return null;
        const body = await res.json();
        return body.status === "closed" ? body : null;
      },
      { attempts: 20, delayMs: 500, label: "workspace.status === closed" },
    );
    expect(ws.status).toBe("closed");

    // (c) Verify issue transitioned to Done.
    const issueAfter = await pollUntil(
      async () => {
        const res = await request.get(
          `${SERVER_URL}/api/issues?projectId=${projectId}&issueNumber=${issueNumber}`,
        );
        if (!res.ok()) return null;
        const list = await res.json();
        const found = list[0];
        return found?.statusId === doneStatusId ? found : null;
      },
      { attempts: 20, delayMs: 500, label: `issue #${issueNumber} to reach Done status` },
    );
    expect(issueAfter.statusId).toBe(doneStatusId);
  });

  test("POST /merge converges state even when client disconnects", async ({ request }) => {
    test.setTimeout(120_000);
    const { workspaceId: disconnectedWorkspaceId, issueNumber, issueId, branchCommitSha, branch } =
      await createCommittedWorkspace("disconnect", request);

    const abortController = new AbortController();
    try {
      const mergeUrl = `${SERVER_URL}/api/workspaces/${disconnectedWorkspaceId}/merge`;
      const mergePromise = fetch(mergeUrl, {
        method: "POST",
        signal: abortController.signal,
      });

      setTimeout(() => abortController.abort(), 25);
      try {
        await mergePromise;
      } catch {
        // Expected for an intentionally dropped connection.
      }

      const ws = await pollUntil(
        async () => {
          const res = await request.get(`${SERVER_URL}/api/workspaces/${disconnectedWorkspaceId}`);
          if (!res.ok()) return null;
          const body = await res.json();
          return body.status === "closed" ? body : null;
        },
        { attempts: 30, delayMs: 500, label: "workspace.status === closed after interrupted merge" },
      );
      expect(ws.status, "interrupted merge should still close workspace").toBe("closed");

      const issueAfter = await pollUntil(
        async () => {
          const res = await request.get(
            `${SERVER_URL}/api/issues?projectId=${projectId}&issueNumber=${issueNumber}`,
          );
          if (!res.ok()) return null;
          const found = await res.json();
          return found?.statusId === doneStatusId ? found : null;
        },
        { attempts: 30, delayMs: 500, label: `issue #${issueNumber} to reach Done after interrupted merge` },
      );
      expect(issueAfter.statusId).toBe(doneStatusId);

      await pollUntil(
        async () => {
          try {
            execSync(`git merge-base --is-ancestor ${branchCommitSha} ${defaultBranch}`, {
              cwd: projectRepoPath,
              stdio: "pipe",
            });
            return true;
          } catch {
            return false;
          }
        },
        { attempts: 30, delayMs: 500, label: `commit ${branchCommitSha} to appear on ${defaultBranch}` },
      );

      await pollUntil(
        async () => {
          return (await branchDeleted(projectRepoPath, branch)) ? true : null;
        },
        { attempts: 30, delayMs: 500, label: `branch ${branch} should be deleted` },
      );
    } finally {
      abortController.abort();
      await request.delete(`${SERVER_URL}/api/workspaces/${disconnectedWorkspaceId}`).catch(() => {});
      await request.delete(`${SERVER_URL}/api/issues/${issueId}`).catch(() => {});
    }
  });

  test("second POST /merge on already-merged workspace does not error the test", async ({
    request,
  }) => {
    // The workspace is already closed from the first test. A second merge call
    // exercises the already-merged-ancestor reconcile path and must not return 5xx.
    const res = await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/merge`);
    expect(res.status(), `Second POST /merge must not return 5xx`).toBeLessThan(500);
  });
});
