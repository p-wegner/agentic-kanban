/**
 * Coverage gap P0 · workspaces.cascade.post-merge-followups
 *
 * Behaviour under test: after a BLOCKER issue's workspace is MERGED, a DEPENDENT
 * issue whose every blocker is now Done must get a NEW workspace auto-created AND
 * be moved to "In Progress" — the post-merge follow-up cascade
 * (`autoStartFollowups` in followup-workspace.service.ts, gated by
 * `maybeAutoStartFollowups` in workspace-merge-cleanup.service.ts).
 *
 * The cascade only fires when the GLOBAL pref `auto_start_followup === "true"`,
 * so we set it in beforeAll and RESTORE the prior value in afterAll. The cascade
 * runs in `setImmediate(...)` AFTER the merge HTTP response returns, so we poll
 * the issue-scoped workspaces endpoint rather than asserting synchronously.
 *
 * In the E2E environment the auto-started agent is the mock agent — but every
 * created workspace (incl. the auto-created one) is still deleted in afterAll.
 *
 * Negative case: a dependent that ALREADY has a non-closed workspace before the
 * merge must NOT get a second one (the `hasActive` skip).
 *
 * ISOLATION — the post-merge handler runs TWO independent cascade paths back-to-back
 * (workspace-merge-cleanup.service.ts:70-71): `maybeAutoStartFollowups` (the path under
 * test, gated by the GLOBAL `auto_start_followup`) AND `maybeAutoStartUnblockedDependency`
 * (dependency-auto-chain.service.ts, gated by `resolveStartPolicy().postMergeCascade`).
 * BOTH produce the identical observable outcome (dependent gets a workspace + moves to In
 * Progress). To make the green attributable to `autoStartFollowups` ALONE, beforeAll PINS
 * the per-project `start_mode_<projectId>` = "manual" and the global `dependency_auto_chain`
 * = "false"; together these force `postMergeCascade=false`, so the dependency path provably
 * cannot fire. All managed prefs are read+saved (only when the read succeeds) and each is
 * restored independently in afterAll.
 *
 * CONCURRENCY — this file MUTATES the GLOBAL `auto_start_followup` (and `dependency_auto_chain`)
 * preference for its whole duration, so it must NOT run concurrently with other
 * cascade-affecting tests (notably tests/ui/auto-start-followup-setting.test.ts), which would
 * race its pref reads/writes. The describe block is configured `mode: "serial"`.
 */

import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProject } from "../helpers/e2e-project.js";

test.describe.configure({ mode: "serial" });

test.describe("post-merge follow-up cascade: dependent issue gets a workspace + In Progress", () => {
  // @covers workspaces.cascade.post-merge-followups [workflow,state-transition,capability]

  let projectId: string;
  let todoStatusId: string;
  let suffix: string;

  // Prefs this file mutates. We only restore a pref whose original value we ACTUALLY read
  // (didReadPrefs gate) so a failed GET can never clobber a previously-true value to a default.
  let startModeKey: string;
  let didReadPrefs = false;
  const originalPrefs: Record<string, string> = {};

  const createdIssueIds: string[] = [];
  const createdWorkspaceIds: string[] = [];

  // --- Retry helper (RULE 7): retry transiently-flaky setup, never test.skip().
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

  type RequestCtx = Parameters<Parameters<typeof test>[1]>[0]["request"];

  async function createIssue(request: RequestCtx, title: string): Promise<string> {
    return withRetry(async () => {
      const res = await request.post(`${SERVER_URL}/api/issues`, {
        // skipAutoReview keeps the merge path simple/deterministic.
        data: { title, statusId: todoStatusId, projectId, skipAutoReview: true },
      });
      if (res.status() !== 201) throw new Error(`POST /api/issues -> ${res.status()}`);
      return (await res.json()).id as string;
    }, `create issue "${title}"`);
  }

  /** Create a workspace for an issue, stop its auto-launched agent, return {id, workingDir}. */
  async function createWorkspace(
    request: RequestCtx,
    issueId: string,
    branch: string,
  ): Promise<{ id: string; workingDir: string }> {
    const ws = await withRetry(async () => {
      const res = await request.post(`${SERVER_URL}/api/workspaces`, {
        data: { issueId, branch },
      });
      if (res.status() !== 201) throw new Error(`POST /api/workspaces -> ${res.status()}`);
      return res.json();
    }, `create workspace ${branch}`);
    createdWorkspaceIds.push(ws.id);
    // Stop any auto-launched mock agent so the workspace is idle (still non-closed).
    await request.post(`${SERVER_URL}/api/workspaces/${ws.id}/stop`).catch(() => {});
    expect(ws.workingDir, `workspace ${branch} must have a workingDir`).toBeTruthy();
    return { id: ws.id, workingDir: ws.workingDir };
  }

  /** Put a real divergent commit on the workspace branch (mirrors merge-cascade.test.ts). */
  function commitMarker(workingDir: string, label: string): void {
    execSync("git config user.email e2e@test.local", { cwd: workingDir });
    execSync("git config user.name E2ETest", { cwd: workingDir });
    const marker = join(workingDir, `e2e-followup-${label}.txt`);
    writeFileSync(marker, `followup cascade marker ${label}\n`);
    execSync("git add -A", { cwd: workingDir });
    execSync(`git commit -m "e2e: followup cascade marker ${label}"`, { cwd: workingDir });
  }

  async function addDependency(request: RequestCtx, dependentId: string, blockerId: string): Promise<void> {
    const res = await request.post(`${SERVER_URL}/api/issues/${dependentId}/dependencies`, {
      data: { dependsOnId: blockerId, type: "depends_on" },
    });
    expect(res.status(), `POST dependency -> ${res.status()}`).toBe(201);
  }

  async function getIssue(request: RequestCtx, issueId: string): Promise<{ statusName: string }> {
    const res = await request.get(`${SERVER_URL}/api/issues/${issueId}`);
    expect(res.ok(), `GET issue ${issueId} -> ${res.status()}`).toBeTruthy();
    return res.json();
  }

  async function listWorkspaces(
    request: RequestCtx,
    issueId: string,
  ): Promise<Array<{ id: string; status: string }>> {
    const res = await request.get(`${SERVER_URL}/api/issues/${issueId}/workspaces`);
    expect(res.ok(), `GET /api/issues/${issueId}/workspaces -> ${res.status()}`).toBeTruthy();
    return res.json();
  }

  const nonClosed = (ws: Array<{ status: string }>) => ws.filter((w) => w.status !== "closed");

  /**
   * Merge a workspace, retrying on the per-repo merge-lock 409 CONFLICT / 5xx. The single
   * shared E2E repo means a parallel test file merging concurrently can briefly hold the lock,
   * so a transient 409 here is contention, not a real conflict — just re-POST.
   */
  async function mergeWorkspace(request: RequestCtx, workspaceId: string, label: string) {
    return withRetry(async () => {
      const res = await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/merge`);
      const status = res.status();
      if (status === 409 || status >= 500) {
        const body = await res.text().catch(() => "");
        throw new Error(`merge ${label} -> ${status} (retryable: merge-lock/server) body=${body}`);
      }
      return res;
    }, `merge ${label}`);
  }

  test.beforeAll(async ({ request }) => {
    test.setTimeout(60_000);

    const project = await withRetry(() => getE2EProject(request), "getE2EProject");
    projectId = project.id;
    expect(project.defaultBranch, "E2E project must have a defaultBranch").toBeTruthy();

    const statuses: Array<{ id: string; name: string }> = await withRetry(async () => {
      const res = await request.get(`${SERVER_URL}/api/projects/${projectId}/statuses`);
      if (!res.ok()) throw new Error(`statuses ${res.status()}`);
      return res.json();
    }, "fetch statuses");
    const todo = statuses.find((s) => s.name === "Todo");
    todoStatusId = todo ? todo.id : statuses[0].id;
    expect(
      statuses.some((s) => s.name === "In Progress"),
      "Cascade asserts move to 'In Progress' — that status must exist on the E2E project",
    ).toBe(true);

    suffix = Date.now().toString(36);
    startModeKey = `start_mode_${projectId}`;

    // Read the current values of every pref we will mutate, so afterAll can restore exactly.
    // GET /preferences/settings returns dynamic per-project keys too (isAllowedDynamicKey),
    // so `start_mode_<id>` shows up here when it is set. A key absent from the response was
    // unset → its effective default ("" derives a Start Mode, "false" for the bools).
    const settingsRes = await request.get(`${SERVER_URL}/api/preferences/settings`);
    expect(settingsRes.ok(), `GET settings -> ${settingsRes.status()}`).toBeTruthy();
    const s = await settingsRes.json();
    originalPrefs.auto_start_followup = s.auto_start_followup ?? "false";
    originalPrefs.dependency_auto_chain = s.dependency_auto_chain ?? "false";
    originalPrefs[startModeKey] = s[startModeKey] ?? "";
    didReadPrefs = true;

    // ENABLE the path under test; PIN the rival path OFF so the green is attributable to
    // autoStartFollowups alone (start_mode=manual + dependency_auto_chain=false ⇒
    // resolveStartPolicy().postMergeCascade === false).
    const putRes = await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: {
        auto_start_followup: "true",
        dependency_auto_chain: "false",
        [startModeKey]: "manual",
      },
    });
    expect(putRes.ok(), `pin cascade prefs -> ${putRes.status()}`).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdWorkspaceIds) {
      await request.delete(`${SERVER_URL}/api/workspaces/${id}`).catch(() => {});
    }
    for (const id of createdIssueIds) {
      await request.delete(`${SERVER_URL}/api/issues/${id}`).catch(() => {});
    }
    // RULE 6: restore each mutated pref to the value we actually read. Skip entirely if the
    // read failed (never clobber an unknown original), and restore each key independently so
    // one failed write doesn't skip the others.
    if (didReadPrefs) {
      for (const [key, value] of Object.entries(originalPrefs)) {
        await request
          .put(`${SERVER_URL}/api/preferences/settings`, { data: { [key]: value } })
          .catch(() => {});
      }
    }
  });

  test("merging a blocker auto-creates a workspace for the unblocked dependent and moves it to In Progress", async ({
    request,
  }) => {
    test.setTimeout(90_000);

    // Arrange: blocker B and dependent D (D depends_on B).
    const blockerId = await createIssue(request, `Cascade blocker ${suffix}`);
    createdIssueIds.push(blockerId);
    const dependentId = await createIssue(request, `Cascade dependent ${suffix}`);
    createdIssueIds.push(dependentId);
    await addDependency(request, dependentId, blockerId);

    // Pre-condition: dependent has NO workspace yet.
    expect(nonClosed(await listWorkspaces(request, dependentId))).toHaveLength(0);

    // Act: build a real commit on B's branch, then merge B (transitions B -> Done).
    const blockerWs = await createWorkspace(request, blockerId, `feature/cascade-blocker-${suffix}`);
    commitMarker(blockerWs.workingDir, `blocker-${suffix}`);
    const mergeRes = await mergeWorkspace(request, blockerWs.id, "blocker");
    expect(mergeRes.status(), `merge blocker -> ${mergeRes.status()}`).toBeLessThan(400);

    // Assert: a NEW non-closed workspace appears for D (cascade runs async post-merge).
    let autoWorkspaceId: string | undefined;
    await expect
      .poll(
        async () => {
          const open = nonClosed(await listWorkspaces(request, dependentId));
          if (open.length > 0) autoWorkspaceId = open[0].id;
          return open.length;
        },
        { timeout: 30_000, message: "dependent must get an auto-created workspace after blocker merge" },
      )
      .toBeGreaterThan(0);

    // Track the auto-created workspace for cleanup (it was not created by this test directly).
    if (autoWorkspaceId && !createdWorkspaceIds.includes(autoWorkspaceId)) {
      createdWorkspaceIds.push(autoWorkspaceId);
    }
    // Stop the auto-launched follow-up agent so it doesn't keep running.
    if (autoWorkspaceId) {
      await request.post(`${SERVER_URL}/api/workspaces/${autoWorkspaceId}/stop`).catch(() => {});
    }

    // Assert: the state transition — D is now In Progress.
    await expect
      .poll(async () => (await getIssue(request, dependentId)).statusName, {
        timeout: 15_000,
        message: "dependent must transition to In Progress when its workspace is auto-started",
      })
      .toBe("In Progress");
  });

  test("dependent that already has an active workspace does NOT get a second one (hasActive skip)", async ({
    request,
  }) => {
    test.setTimeout(90_000);

    // Arrange: blocker B2 and dependent D2 (D2 depends_on B2).
    const blockerId = await createIssue(request, `Cascade neg blocker ${suffix}`);
    createdIssueIds.push(blockerId);
    const dependentId = await createIssue(request, `Cascade neg dependent ${suffix}`);
    createdIssueIds.push(dependentId);
    await addDependency(request, dependentId, blockerId);

    // D2 ALREADY has a non-closed workspace before the merge -> cascade must skip it.
    await createWorkspace(request, dependentId, `feature/cascade-neg-dep-${suffix}`);
    expect(nonClosed(await listWorkspaces(request, dependentId))).toHaveLength(1);

    // Act: commit + merge B2 (transitions B2 -> Done, unblocking D2).
    const blockerWs = await createWorkspace(request, blockerId, `feature/cascade-neg-blocker-${suffix}`);
    commitMarker(blockerWs.workingDir, `neg-blocker-${suffix}`);
    const mergeRes = await mergeWorkspace(request, blockerWs.id, "neg blocker");
    expect(mergeRes.status(), `merge neg blocker -> ${mergeRes.status()}`).toBeLessThan(400);

    // Anchor: wait for the merge to fully process (B2 reaches a terminal status), so the
    // async post-merge cascade has been given its chance to run.
    await expect
      .poll(async () => (await getIssue(request, blockerId)).statusName, {
        timeout: 30_000,
        message: "blocker must reach Done so the cascade decision executes",
      })
      .toBe("Done");

    // Assert: over a window comfortably longer than the cascade latency observed in the
    // positive test, D2 NEVER gains a second non-closed workspace. A regressed/missing
    // hasActive skip would create one within seconds (same code path as the positive case).
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const open = nonClosed(await listWorkspaces(request, dependentId));
      expect(
        open.length,
        `dependent with a pre-existing workspace must not get a second one (saw ${open.length})`,
      ).toBe(1);
      await new Promise((r) => setTimeout(r, 1_000));
    }
  });
});
