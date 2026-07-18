// @covers review-merge.recover.fix-and-merge [api,state-transition,workflow]
/**
 * api-dimension coverage for review-merge.recover.fix-and-merge.
 *
 * The resolver-EXIT recovery and zombie-fix recovery are already asserted
 * (stranded-fix-and-merge-resolver-exit.test.ts + workspace-merge-service.test.ts),
 * but the POST /api/workspaces/:id/fix-and-merge ENDPOINT itself — that it
 * transitions the workspace to status=fixing and relaunches a fix agent in the
 * worktree — was never driven end-to-end. An endpoint-level regression (route not
 * wired, status not set to fixing, agent not launched, session id not tracked)
 * would be invisible. This drives the real Hono route via app.request().
 *
 * The boundaries the route factory does NOT let us inject (the default git
 * service, the DB backup, and the worktree process-killer) are module-mocked so
 * the blocked-merge recovery is deterministic and no real agent / git / process
 * work happens — mirroring the makeGit() harness of workspace-merge-service.test.ts.
 */

import { vi } from "vitest";

// ── Deterministic git boundary (route uses the module default, not an injected one).
//    Mirrors makeGit() from workspace-merge-service.test.ts so BOTH the fix-and-merge
//    rebuild preflight AND a clean merge resolve deterministically. A fresh instance
//    per test (beforeEach) resets the stateful counters; the mocked module namespace
//    forwards every named export to the live per-test instance.
const makeGitH = vi.hoisted(() => {
  return function makeGit(overrides: Record<string, (...a: unknown[]) => unknown> = {}) {
    return {
      getDiff: vi.fn(async () => ""),
      getDiffFromRepo: vi.fn(async () => ""),
      revParse: vi.fn(async (_repo: string, ref: string) => {
        if (ref === "feature/ak-548-test") return "feature-sha";
        if (ref === "master") return "master-sha-before";
        return "merge-commit-sha";
      }),
      isAncestor: vi.fn(async () => false),
      mergeBranch: vi.fn(async () => "Merge made by the 'ort' strategy."),
      detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
      detectConflictsByBranch: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
      countBehindCommits: vi.fn(async () => 0),
      abortRebase: vi.fn(async () => {}),
      getConflictingFiles: vi.fn(async () => []),
      syncBranchToHead: vi.fn(async () => false),
      removeWorktree: vi.fn(async () => {}),
      deleteBranch: vi.fn(async () => {}),
      getChangedFilesBetween: vi.fn(async () => []),
      getCurrentBranch: vi.fn(async () => "master"),
      autoRenumberMigrations: vi.fn(async () => ({ renumbered: false, renames: [] })),
      checkBranchTipIsAncestor: (() => {
        let calls = 0;
        return vi.fn(async () => {
          calls++;
          if (calls === 1) return { isAncestor: false as const, branchSha: "feature-sha", baseSha: "master-sha-before" };
          return { isAncestor: true as const, branchSha: "feature-sha", baseSha: "merge-commit-sha" };
        });
      })(),
      getUncommittedTrackedChanges: vi.fn(async () => []),
      countUniqueCommits: vi.fn(async () => 1),
      rebaseOntoBase: vi.fn(async () => ({ success: true })),
      mergeBaseIntoBranch: vi.fn(async () => ({ success: true })),
      ...overrides,
    } as Record<string, (...a: unknown[]) => unknown>;
  };
});

const gitHolder = vi.hoisted(() => ({ current: null as Record<string, (...a: unknown[]) => unknown> | null }));

vi.mock("../services/git.service.js", () => {
  const sample = makeGitH();
  const ns: Record<string, unknown> = {};
  for (const key of Object.keys(sample)) {
    ns[key] = (...args: unknown[]) => gitHolder.current![key](...args);
  }
  return ns;
});

// The merge path's other two un-injectable boundaries: DB backup + worktree process kill.
vi.mock("../db/backup.js", () => ({ createBackup: vi.fn(async () => {}) }));
vi.mock("../services/process-cleanup.js", () => ({ killProcessesInDir: vi.fn(async () => 0) }));

import { Hono } from "hono";
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, repos, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceActionsRoute } from "../routes/workspace-actions.js";
import { activeMerges } from "../services/workspace-internals.js";

/** Seed a project (In Review + Done), an In-Review issue, and an idle reviewed workspace. */
async function seedWorkspace(
  db: ReturnType<typeof createTestDb>["db"],
  opts: { status?: string; readyForMerge?: boolean } = {},
) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const inReviewStatusId = randomUUID();
  const doneStatusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: inReviewStatusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now },
    { id: doneStatusId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
  ]);
  await db.insert(issues).values({
    id: issueId, issueNumber: 548, title: "Test issue", priority: "medium",
    sortOrder: 0, statusId: inReviewStatusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId,
    branch: "feature/ak-548-test",
    workingDir: "/repo/.worktrees/feature_ak-548-test",
    baseBranch: "master", isDirect: false,
    status: opts.status ?? "idle",
    readyForMerge: opts.readyForMerge ?? true,
    provider: "claude", createdAt: now, updatedAt: now,
  });

  return { projectId, issueId, workspaceId, doneStatusId, inReviewStatusId };
}

function mountRoute(
  db: ReturnType<typeof createTestDb>["db"],
  startSession: ReturnType<typeof vi.fn>,
  fixAndMergeSessionIds: Set<string>,
) {
  const sessionManager = {
    startSession,
    stopSession: vi.fn(async () => true),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    wsRoute: vi.fn(() => () => {}),
  };
  const boardEvents = { broadcast: vi.fn(), broadcastActivity: vi.fn() };
  const app = new Hono();
  app.route(
    "/api/workspaces",
    createWorkspaceActionsRoute(
      () => sessionManager as never,
      db as never,
      { boardEvents: boardEvents as never, fixAndMergeSessionIds },
    ),
  );
  return app;
}

describe("POST /api/workspaces/:id/fix-and-merge — endpoint drives status→fixing + agent relaunch", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    activeMerges.clear();
    gitHolder.current = makeGitH();
    ({ db } = createTestDb());
  });

  it("recoverable blocked merge: launches a fix agent in the worktree and transitions the workspace to fixing", async () => {
    const { workspaceId, issueId, inReviewStatusId } = await seedWorkspace(db);
    const startSession = vi.fn(async () => "fix-session-1");
    const fixAndMergeSessionIds = new Set<string>();
    const app = mountRoute(db, startSession, fixAndMergeSessionIds);

    const res = await app.request(`/api/workspaces/${workspaceId}/fix-and-merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mergeError: "CONFLICT (content): Merge conflict in src/foo.ts" }),
    });

    // api: the endpoint accepts the recovery request and reports the launched session.
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ sessionId: "fix-session-1" });

    // workflow: a fix-and-merge agent session is actually launched in the worktree.
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        triggerType: "fix-and-merge",
        skipLaunchPreflight: true,
      }),
    );

    // state-transition: the workspace moves to `fixing` (it now counts as active).
    const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("fixing");

    // The route tracks the launched session so its exit runs the fix-and-merge workflow.
    expect(fixAndMergeSessionIds.has("fix-session-1")).toBe(true);

    // The issue is NOT moved to Done — recovery is in progress, the branch has not landed.
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    expect(issue.statusId).toBe(inReviewStatusId);
  });

  it("preflight rebase CONFLICT: aborts the rebase (worktree left attached, not detached mid-rebase) then still launches the agent", async () => {
    // Regression for the fix-and-merge stranding defect: when the preflight rebase conflicts,
    // the worktree must NOT be left in a detached mid-rebase state — otherwise the reconciler
    // agent launches into a worktree the stale-safety guard rejects, produces zero output, and
    // /resolve-conflicts refuses to recover it (STALE_SAFETY_POLICY catch-22). The fix aborts
    // the conflicted rebase so the worktree returns to its attached branch HEAD.
    const { workspaceId } = await seedWorkspace(db);
    gitHolder.current = makeGitH({
      rebaseOntoBase: vi.fn(async () => ({ success: false, conflictingFiles: ["src/server.js"] })),
    });
    const startSession = vi.fn(async () => "fix-session-conflict");
    const fixAndMergeSessionIds = new Set<string>();
    const app = mountRoute(db, startSession, fixAndMergeSessionIds);

    const res = await app.request(`/api/workspaces/${workspaceId}/fix-and-merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mergeError: "CONFLICT (content): Merge conflict in src/server.js" }),
    });

    expect(res.status).toBe(201);
    // THE FIX: the conflicted preflight rebase is aborted so the worktree is left attached.
    expect(gitHolder.current.abortRebase).toHaveBeenCalled();
    // The agent is still launched and the workspace still enters `fixing` (recovery in progress).
    expect(startSession).toHaveBeenCalledTimes(1);
    const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("fixing");
  });

  it("MULTI-REPO preflight conflict: rebases EVERY sibling worktree and the reconcile prompt enumerates each one (#105)", async () => {
    // Regression for the fix-and-merge leading-repo blind spot: a cross-cutting overlapping
    // ticket touches all repos, but fix-and-merge used to rebase ONLY the leading worktree and
    // the prompt named ONLY "this branch" — so the reconciler resolved the leading repo, reported
    // "ready to land", and left every sibling conflicted against its advanced main (atomic merge
    // blocked forever). The fix rebases each sibling worktree too and, on conflict, hands the agent
    // an explicit per-worktree reconcile checklist that includes the sibling worktree paths.
    const { workspaceId, projectId } = await seedWorkspace(db);
    const now = new Date().toISOString();
    const siblingWorktree = "/repo2/.worktrees/feature_ak-548-test";
    await db.insert(repos).values({
      id: randomUUID(), workspaceId, projectId, path: "/repo2", name: "sibling-svc",
      worktreePath: siblingWorktree, branch: "feature/ak-548-test", baseBranch: "master", createdAt: now,
    });

    // Every worktree's rebase conflicts → both leading and sibling need a `git merge` reconcile.
    gitHolder.current = makeGitH({
      rebaseOntoBase: vi.fn(async () => ({ success: false, conflictingFiles: ["src/server.js"] })),
    });
    const startSession = vi.fn(async () => "fix-session-multirepo");
    const fixAndMergeSessionIds = new Set<string>();
    const app = mountRoute(db, startSession, fixAndMergeSessionIds);

    const res = await app.request(`/api/workspaces/${workspaceId}/fix-and-merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mergeError: "CONFLICT (content): Merge conflict in src/server.js" }),
    });

    expect(res.status).toBe(201);
    // Both worktrees' conflicted rebases were aborted (worktrees left attached, not detached).
    expect(gitHolder.current.abortRebase).toHaveBeenCalledTimes(2);
    // The reconcile prompt must be MULTI-REPO aware and NAME the sibling worktree so the agent
    // cannot stop after the leading repo.
    const prompt = startSession.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("MULTI-REPO");
    expect(prompt).toContain(siblingWorktree);
    expect(prompt).toContain("sibling repo 'sibling-svc'");
    expect(prompt).toContain("leading repo");
  });

  it("a SECOND fix-and-merge while one is already running is rejected as a conflict (no duplicate launch)", async () => {
    const { workspaceId } = await seedWorkspace(db, { status: "fixing" });
    // A running fix-and-merge session younger than the zero-output recovery window,
    // so the in-progress guard fires instead of recovering.
    await db.insert((await import("@agentic-kanban/shared/schema")).sessions).values({
      id: randomUUID(), workspaceId, executor: "claude-code", status: "running",
      startedAt: new Date().toISOString(), triggerType: "fix-and-merge",
    });
    const startSession = vi.fn(async () => "fix-session-dup");
    const app = mountRoute(db, startSession, new Set<string>());

    const res = await app.request(`/api/workspaces/${workspaceId}/fix-and-merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mergeError: "conflict" }),
    });

    expect(res.status).toBe(409);
    expect(startSession).not.toHaveBeenCalled();
    const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("fixing");
  });
});

describe("POST /api/workspaces/:id/merge — a clean merge does NOT launch a fix session", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    activeMerges.clear();
    gitHolder.current = makeGitH();
    ({ db } = createTestDb());
  });

  it("a clean, non-conflicting merge just lands (workspace closed, issue Done) without entering fixing", async () => {
    const { workspaceId, issueId } = await seedWorkspace(db);
    const startSession = vi.fn(async () => "should-not-launch");
    const app = mountRoute(db, startSession, new Set<string>());

    const res = await app.request(`/api/workspaces/${workspaceId}/merge`, { method: "POST" });

    expect(res.status).toBe(200);

    // The contrast that makes fix-and-merge meaningful: a clean merge never relaunches an agent.
    expect(startSession).not.toHaveBeenCalled();

    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).not.toBe("fixing");
    expect(ws.status).toBe("closed");
    expect(ws.mergedAt).toBeTruthy();

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");
  });
});
