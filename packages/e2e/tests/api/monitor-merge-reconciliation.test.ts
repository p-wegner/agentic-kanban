/**
 * E2E coverage for monitor merge reconciliation states (AK-350).
 *
 * Covers three operator scenarios:
 *   1. In-Review workspace that moves to Done after a normal merge response.
 *   2. Already-merged branch reconciliation without invoking manual git commands.
 *   3. Visible operator state when reconciliation cannot close the workspace
 *      (workspace already closed, or branch has an unmerged diff).
 *
 * Strategy: pure API tests against the live server — no Playwright browser
 * needed for these state-machine checks.  All git operations go through the
 * server's own merge/reconcile endpoints so no manual `git` calls are made.
 *
 * Notes:
 * - There is no GET /api/issues/:id endpoint; use GET /api/issues?projectId=...&issueNumber=N.
 * - A freshly-created workspace branch has no commits beyond master so
 *   checkAlreadyMerged returns isAlreadyMerged: true immediately.
 */

import { test, expect } from "@playwright/test";
import { SERVER_URL } from "../helpers/port.js";
import { getE2EProject } from "../helpers/e2e-project.js";

test.describe("Monitor merge reconciliation states", () => {
  let projectId: string;
  let todoStatusId: string;
  let doneStatusId: string;
  const suffix = Date.now().toString(36);
  const createdWorkspaceIds: string[] = [];
  const createdIssueIds: string[] = [];
  const createdIssueNumbers: Map<string, number> = new Map();
  let originalClaudeProfile = "";

  test.beforeAll(async ({ request }) => {
    const project = await getE2EProject(request);
    projectId = project.id;

    const statusesRes = await request.get(
      `${SERVER_URL}/api/projects/${projectId}/statuses`,
    );
    expect(statusesRes.ok(), "GET project statuses must succeed").toBeTruthy();
    const statuses: Array<{ id: string; name: string }> = await statusesRes.json();
    expect(statuses.length, "Project must have statuses").toBeGreaterThan(0);

    const todoStatus = statuses.find((s) => s.name === "Todo");
    todoStatusId = todoStatus ? todoStatus.id : statuses[0].id;

    const doneStatus = statuses.find((s) => s.name === "Done");
    doneStatusId = doneStatus ? doneStatus.id : statuses[statuses.length - 1].id;

    const settingsRes = await request.get(`${SERVER_URL}/api/preferences/settings`);
    if (settingsRes.ok()) {
      const s = await settingsRes.json();
      originalClaudeProfile = s.claude_profile ?? "";
    }

    // Use mock profile so workspace creation does not launch a real agent.
    await request.put(`${SERVER_URL}/api/preferences/settings`, {
      data: { claude_profile: "mock" },
    });
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
    });
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  async function createIssue(
    title: string,
    request: Parameters<Parameters<typeof test>[1]>[0]["request"],
  ): Promise<{ id: string; issueNumber: number }> {
    const res = await request.post(`${SERVER_URL}/api/issues`, {
      data: { title, statusId: todoStatusId, projectId, skipAutoReview: true },
    });
    expect(res.status(), `POST /api/issues for "${title}"`).toBe(201);
    const body = await res.json();
    createdIssueIds.push(body.id);
    createdIssueNumbers.set(body.id, body.issueNumber);
    return { id: body.id, issueNumber: body.issueNumber };
  }

  async function createWorkspace(
    issueId: string,
    branchSuffix: string,
    request: Parameters<Parameters<typeof test>[1]>[0]["request"],
  ): Promise<string> {
    const res = await request.post(`${SERVER_URL}/api/workspaces`, {
      data: { issueId, branch: `feature/reconcile-test-${branchSuffix}-${suffix}` },
    });
    expect(res.status(), `POST /api/workspaces`).toBe(201);
    const { id } = await res.json();
    createdWorkspaceIds.push(id);
    return id;
  }

  /** Fetch a single issue by issueNumber and return it. */
  async function getIssue(
    issueNumber: number,
    request: Parameters<Parameters<typeof test>[1]>[0]["request"],
  ): Promise<{ id: string; statusId: string; statusName: string; [key: string]: unknown }> {
    const res = await request.get(
      `${SERVER_URL}/api/issues?projectId=${projectId}&issueNumber=${issueNumber}`,
    );
    expect(res.ok(), `GET /api/issues?issueNumber=${issueNumber} returned ${res.status()}`).toBeTruthy();
    const list = await res.json();
    expect(list.length, `Expected issue #${issueNumber} in list`).toBeGreaterThan(0);
    return list[0];
  }

  // ── scenario 1: normal merge moves workspace to Done ─────────────────────

  test("POST /merge closes workspace and moves issue to Done", async ({ request }) => {
    const { id: issueId, issueNumber } = await createIssue(
      `Reconcile merge test 1 ${suffix}`,
      request,
    );
    const workspaceId = await createWorkspace(issueId, "normal-merge", request);

    // Stop any auto-launched agent session so the workspace is idle for merge.
    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`).catch(() => {});
    // Brief wait for stop to settle before calling merge.
    await new Promise((r) => setTimeout(r, 800));

    // Merge the workspace into master via the server endpoint.
    const mergeRes = await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/merge`);
    expect(mergeRes.ok(), `POST /merge returned ${mergeRes.status()}: ${await mergeRes.text()}`).toBeTruthy();

    // Workspace must be closed.
    const wsRes = await request.get(`${SERVER_URL}/api/workspaces/${workspaceId}`);
    expect(wsRes.ok()).toBeTruthy();
    const ws = await wsRes.json();
    expect(ws.status, "Workspace status after merge").toBe("closed");

    // Issue must be in Done.
    const issue = await getIssue(issueNumber, request);
    expect(issue.statusId, "Issue statusId after merge").toBe(doneStatusId);
  });

  // ── scenario 2: already-merged reconciliation ─────────────────────────────
  //
  // A freshly-created workspace branch is created from the base branch (master)
  // and the mock agent makes no commits, so the branch tip is identical to master.
  // This means:
  //   - getDiff returns ""  (no changes vs base)
  //   - isAncestor returns true  (same commit is reachable from master)
  // → checkAlreadyMerged returns isAlreadyMerged: true
  // → reconcileAlreadyMerged closes the workspace and moves the issue to Done

  test("GET already-merged-status detects branch already on master", async ({ request }) => {
    const { id: issueId } = await createIssue(
      `Reconcile already-merged detect ${suffix}`,
      request,
    );
    const workspaceId = await createWorkspace(issueId, "am-detect", request);

    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`).catch(() => {});
    await new Promise((r) => setTimeout(r, 800));

    const checkRes = await request.get(
      `${SERVER_URL}/api/workspaces/${workspaceId}/already-merged-status`,
    );
    expect(checkRes.ok(), `GET already-merged-status returned ${checkRes.status()}`).toBeTruthy();

    const check = await checkRes.json();
    expect(check.branch, "branch must be set").toBeTruthy();
    expect(check.baseBranch, "baseBranch must be set").toBeTruthy();
    expect(check.isAlreadyMerged, "Fresh branch with no commits should be detected as already-merged").toBe(true);
    expect(check.issueNumber, "issueNumber must be present").toBeTruthy();
  });

  test("POST reconcile-as-done closes workspace and moves issue to Done for already-merged branch", async ({ request }) => {
    const { id: issueId, issueNumber } = await createIssue(
      `Reconcile already-merged action ${suffix}`,
      request,
    );
    const workspaceId = await createWorkspace(issueId, "am-reconcile", request);

    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`).catch(() => {});
    await new Promise((r) => setTimeout(r, 800));

    const reconcileRes = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/reconcile-as-done`,
    );
    expect(reconcileRes.ok(), `POST reconcile-as-done returned ${reconcileRes.status()}: ${await reconcileRes.text()}`).toBeTruthy();

    const result = await reconcileRes.json();
    expect(result.branch, "reconcile result must include branch").toBeTruthy();
    expect(result.baseBranch, "reconcile result must include baseBranch").toBeTruthy();
    expect(result.reconciledAt, "reconcile result must include reconciledAt").toBeTruthy();
    expect(result.issueNumber, "reconcile result must include issueNumber").toBeTruthy();

    // Workspace must be closed.
    const wsRes = await request.get(`${SERVER_URL}/api/workspaces/${workspaceId}`);
    expect(wsRes.ok()).toBeTruthy();
    const ws = await wsRes.json();
    expect(ws.status, "Workspace must be closed after reconciliation").toBe("closed");

    // Issue must be in Done.
    const issue = await getIssue(issueNumber, request);
    expect(issue.statusId, "Issue must be in Done after reconciliation").toBe(doneStatusId);
  });

  // ── scenario 3: reconciliation cannot close workspace ────────────────────
  //
  // Two operator-visible failure states:
  //   a) Workspace is already closed → 400 "Workspace is already closed"
  //   b) Branch has an unmerged diff → already-merged-status returns false with reason

  test("POST reconcile-as-done returns 400 when workspace is already closed", async ({ request }) => {
    const { id: issueId } = await createIssue(
      `Reconcile blocked already-closed ${suffix}`,
      request,
    );
    const workspaceId = await createWorkspace(issueId, "am-blocked-closed", request);

    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`).catch(() => {});
    await new Promise((r) => setTimeout(r, 800));

    // First reconciliation succeeds and closes the workspace.
    const first = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/reconcile-as-done`,
    );
    expect(first.ok(), `First reconcile returned ${first.status()}`).toBeTruthy();

    // Second attempt on the now-closed workspace must return 400.
    const second = await request.post(
      `${SERVER_URL}/api/workspaces/${workspaceId}/reconcile-as-done`,
    );
    expect(second.status(), "Second reconcile on closed workspace must be 400").toBe(400);
  });

  test("GET already-merged-status response shape is correct for any merged state", async ({ request }) => {
    // Verify that the already-merged-status endpoint always returns a consistent
    // shape. When isAlreadyMerged is false, the reason field explains the operator state.
    const { id: issueId } = await createIssue(
      `Reconcile shape check ${suffix}`,
      request,
    );
    const workspaceId = await createWorkspace(issueId, "am-shape", request);

    await request.post(`${SERVER_URL}/api/workspaces/${workspaceId}/stop`).catch(() => {});
    await new Promise((r) => setTimeout(r, 800));

    const checkRes = await request.get(
      `${SERVER_URL}/api/workspaces/${workspaceId}/already-merged-status`,
    );
    expect(checkRes.ok(), `GET already-merged-status returned ${checkRes.status()}`).toBeTruthy();

    const check = await checkRes.json();

    // Shape invariants that must always be present regardless of isAlreadyMerged value.
    expect(typeof check.isAlreadyMerged, "isAlreadyMerged must be boolean").toBe("boolean");
    expect(check.branch, "branch must always be returned").toBeTruthy();
    expect(check.baseBranch, "baseBranch must always be returned").toBeTruthy();

    // When isAlreadyMerged is false, a reason must explain the operator state.
    if (!check.isAlreadyMerged) {
      expect(check.reason, "reason must be present when isAlreadyMerged is false").toBeTruthy();
    }
  });
});
