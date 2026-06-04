/**
 * Integration test for AK-487: merge cascade of N In-Review workspaces must not
 * crash the board endpoint.
 *
 * Observed repeatedly during monitor cycles: merging 3-4 In-Review workspaces
 * back-to-back via POST /api/workspaces/:id/merge intermittently drops the HTTP
 * connection and the board endpoint briefly flaps before tsx auto-recovers.
 *
 * Strategy:
 *   1. Seed 5 issues, each with a workspace that has a unique committed file so
 *      the branches diverge from master (forcing a real git merge, not the
 *      already-merged shortcut).
 *   2. Fire all merge requests concurrently (Promise.all) to reproduce the
 *      rapid-succession pattern that triggers the cascade.
 *   3. Interleave board polls both during and after the merge burst.
 *   4. Assert GET /api/projects/:id/board returns 200 with valid shape on every
 *      poll throughout and after.
 *
 * If a real defect surfaces (e.g. a synchronous merge blocking the event loop),
 * file a linked follow-up rather than fixing inline here.
 */

import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProject } from "../helpers/e2e-project.js";

const WORKSPACE_COUNT = 5;

test.describe("merge cascade: board endpoint must stay responsive", () => {
  let projectId: string;
  let projectRepoPath: string;
  let defaultBranch: string;
  let todoStatusId: string;
  let originalClaudeProfile = "";
  const suffix = Date.now().toString(36);

  const createdIssueIds: string[] = [];
  const createdWorkspaceIds: string[] = [];

  interface WorkspaceEntry {
    workspaceId: string;
    workingDir: string;
    branchCommitSha: string;
  }
  const workspaces: WorkspaceEntry[] = [];

  test.beforeAll(async ({ request }) => {
    test.setTimeout(180_000);

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

    // Save and override claude_profile so workspace creation never launches a
    // real agent during this test.
    const settingsRes = await request.get(`${SERVER_URL}/api/preferences/settings`);
    if (settingsRes.ok()) {
      const s = await settingsRes.json();
      originalClaudeProfile = s.claude_profile ?? "";
    }
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { claude_profile: "mock" },
    });

    // Seed WORKSPACE_COUNT issues, each with a workspace that has a unique
    // committed file so the branch diverges from master.
    for (let i = 0; i < WORKSPACE_COUNT; i++) {
      // Create issue.
      const issueRes = await request.post(`${SERVER_URL}/api/issues`, {
        data: {
          title: `Merge cascade test ${suffix} #${i}`,
          statusId: todoStatusId,
          projectId,
          skipAutoReview: true,
        },
      });
      expect(issueRes.status(), `POST /api/issues [${i}] returned ${issueRes.status()}`).toBe(201);
      const issue = await issueRes.json();
      createdIssueIds.push(issue.id);

      // Create workspace (creates the git worktree).
      const wsRes = await request.post(`${SERVER_URL}/api/workspaces`, {
        data: {
          issueId: issue.id,
          branch: `feature/merge-cascade-${suffix}-${i}`,
        },
      });
      expect(wsRes.status(), `POST /api/workspaces [${i}] returned ${wsRes.status()}`).toBe(201);
      const ws = await wsRes.json();
      createdWorkspaceIds.push(ws.id);

      const { id: workspaceId, workingDir } = ws;
      expect(workingDir, `workspace [${i}] must have a workingDir`).toBeTruthy();

      // Stop any auto-launched mock agent so the workspace is idle.
      await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`).catch(() => {});

      // Commit a unique file so the branch diverges from master.
      execSync("git config user.email e2e@test.local", { cwd: workingDir });
      execSync("git config user.name E2ETest", { cwd: workingDir });
      const markerFile = join(workingDir, `e2e-cascade-marker-${suffix}-${i}.txt`);
      writeFileSync(markerFile, `cascade test marker ${suffix} workspace ${i}\n`);
      execSync("git add -A", { cwd: workingDir });
      execSync(
        `git commit -m "e2e: cascade test marker ${suffix} workspace ${i}"`,
        { cwd: workingDir },
      );

      const branchCommitSha = execSync("git rev-parse HEAD", { cwd: workingDir })
        .toString()
        .trim();

      workspaces.push({ workspaceId, workingDir, branchCommitSha });
    }
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`).catch(() => {});
    }
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`).catch(() => {});
    }
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { claude_profile: originalClaudeProfile },
    }).catch(() => {});
  });

  /** Assert the board endpoint returns 200 with a valid array shape. */
  async function assertBoardHealthy(
    request: Parameters<Parameters<typeof test>[1]>[0]["request"],
    label: string,
  ): Promise<void> {
    const res = await request.get(`${SERVER_URL}/api/projects/${projectId}/board`);
    expect(
      res.status(),
      `GET /board must return 200 (${label}), got ${res.status()}`,
    ).toBe(200);
    const body = await res.json();
    expect(
      Array.isArray(body),
      `GET /board must return an array (${label})`,
    ).toBe(true);
    expect(
      body.length,
      `GET /board must return at least one status column (${label})`,
    ).toBeGreaterThan(0);
    // Each column must have an id and an issues array.
    for (const col of body) {
      expect(col.id, `Each board column must have an id (${label})`).toBeTruthy();
      expect(
        Array.isArray(col.issues),
        `Each board column must have an issues array (${label})`,
      ).toBe(true);
    }
  }

  test(
    "board stays responsive while N workspaces merge in rapid succession",
    async ({ request }) => {
      test.setTimeout(120_000);

      // Sanity: board is healthy before the cascade begins.
      await assertBoardHealthy(request, "pre-cascade");

      // Poll the board endpoint every 100 ms while the merges are running.
      // Track failures so we don't throw inside a floating promise.
      const boardPollFailures: string[] = [];
      let pollingActive = true;

      const boardPollingPromise = (async () => {
        while (pollingActive) {
          const res = await request
            .get(`${SERVER_URL}/api/projects/${projectId}/board`)
            .catch((e: unknown) => {
              boardPollFailures.push(`board request threw: ${String(e)}`);
              return null;
            });
          if (res !== null) {
            if (res.status() !== 200) {
              boardPollFailures.push(
                `GET /board returned ${res.status()} during merge cascade`,
              );
            } else {
              const body = await res.json().catch(() => null);
              if (!Array.isArray(body)) {
                boardPollFailures.push(
                  `GET /board returned non-array body during merge cascade`,
                );
              }
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      })();

      // Fire merges back-to-back (sequential with a brief pause between each) to
      // reproduce the rapid-succession pattern from the bug report.
      // Using Promise.all would hit the per-repo merge mutex and only let one merge
      // through — the other four would get 409 CONFLICT immediately, never landing
      // their commits on master and making Test 2 fail.
      const mergeResults: Array<{ workspaceId: string; status: number }> = [];
      for (const { workspaceId } of workspaces) {
        const r = await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/merge`);
        mergeResults.push({ workspaceId, status: r.status() });
        // Brief pause between merges to mimic the rapid but non-simultaneous
        // cadence observed during monitor cycles.
        await new Promise((resolve) => setTimeout(resolve, 150));
      }

      // Stop the board polling.
      pollingActive = false;
      await boardPollingPromise;

      // Merge results: each must not be a hard 5xx server error.
      for (const { workspaceId, status } of mergeResults) {
        expect(
          status,
          `POST /merge for workspace ${workspaceId} must not return 5xx`,
        ).toBeLessThan(500);
      }

      // Board must have been healthy throughout the cascade.
      expect(
        boardPollFailures,
        `Board must be healthy during cascade. Failures:\n${boardPollFailures.join("\n")}`,
      ).toHaveLength(0);

      // Board must still be healthy after the cascade completes.
      await assertBoardHealthy(request, "post-cascade immediate");

      // Brief settle period, then one final check.
      await new Promise((r) => setTimeout(r, 1_000));
      await assertBoardHealthy(request, "post-cascade settled");
    },
  );

  test(
    "all seeded workspace branches reach master after the cascade",
    async ({ request }) => {
      test.setTimeout(60_000);

      // Poll until every branch commit is reachable from master (or timeout).
      for (const { branchCommitSha, workspaceId } of workspaces) {
        let landed = false;
        for (let attempt = 0; attempt < 30; attempt++) {
          try {
            execSync(
              `git merge-base --is-ancestor ${branchCommitSha} ${defaultBranch}`,
              { cwd: projectRepoPath, stdio: "pipe" },
            );
            landed = true;
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 500));
          }
        }
        expect(
          landed,
          `Branch commit ${branchCommitSha} (workspace ${workspaceId}) must reach ${defaultBranch} after cascade`,
        ).toBe(true);
      }
    },
  );
});
