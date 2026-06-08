/**
 * Integration tests for the merge-flap scenario (#701 / #668-#669-#686 family).
 *
 * The board monitor hits this every cycle:
 *   POST /api/workspaces/:id/merge → git commit lands on master → server flaps (~10s 503)
 *   → response never returns → issue strands In Review.
 *
 * Two sub-scenarios are tested:
 *
 *   A. Connection drop AFTER stampMergedAtEarly (mergedAt written) but before response
 *      → on retry the service detects mergedAt and reconciles idempotently to Done.
 *
 *   B. Connection drop BEFORE stampMergedAtEarly (mergedAt not yet written) but the
 *      branch is already an ancestor of master (git merge landed)
 *      → on retry resolveMergeState returns reconcile → issue moves to Done, no double-merge.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceMergeService } from "../services/workspace-merge.service.js";

function makeGit(overrides: Partial<Record<string, (...a: unknown[]) => unknown>> = {}) {
  return {
    getDiff: vi.fn(async () => ""),
    getDiffFromRepo: vi.fn(async () => ""),
    revParse: vi.fn(async (_repo: string, ref: string) => {
      if (ref === "feature/ak-701-flap") return "feature-sha";
      if (ref === "master") return "master-sha";
      return "merge-commit-sha";
    }),
    isAncestor: vi.fn(async () => false),
    mergeBranch: vi.fn(async () => "Merge made by the 'ort' strategy."),
    detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
    syncBranchToHead: vi.fn(async () => false),
    removeWorktree: vi.fn(async () => {}),
    deleteBranch: vi.fn(async () => {}),
    getChangedFilesBetween: vi.fn(async () => []),
    getCurrentBranch: vi.fn(async () => "master"),
    autoRenumberMigrations: vi.fn(async () => ({ renumbered: false, renames: [] })),
    checkBranchTipIsAncestor: vi.fn(async () => ({
      isAncestor: false as const,
      branchSha: "feature-sha",
      baseSha: "master-sha",
    })),
    getUncommittedTrackedChanges: vi.fn(async () => []),
    countUniqueCommits: vi.fn(async () => 1),
    rebaseOntoBase: vi.fn(async () => ({ success: true })),
    mergeBaseIntoBranch: vi.fn(async () => ({ success: true })),
    ...overrides,
  };
}

async function seedWorkspace(
  db: ReturnType<typeof createTestDb>["db"],
  opts: { mergedAt?: string | null; status?: string; readyForMerge?: boolean } = {},
) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const inReviewStatusId = randomUUID();
  const doneStatusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    name: "Flap Test Project",
    repoPath: "/repo",
    repoName: "repo",
    defaultBranch: "master",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: inReviewStatusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now },
    { id: doneStatusId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
  ]);
  await db.insert(issues).values({
    id: issueId,
    issueNumber: 701,
    title: "Merge flap test issue",
    priority: "medium",
    sortOrder: 0,
    statusId: inReviewStatusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/ak-701-flap",
    workingDir: "/repo/.worktrees/feature_ak-701-flap",
    baseBranch: "master",
    isDirect: false,
    status: opts.status ?? (opts.mergedAt ? "closed" : "idle"),
    readyForMerge: opts.readyForMerge ?? true,
    mergedAt: opts.mergedAt ?? null,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });

  return { projectId, issueId, workspaceId, inReviewStatusId, doneStatusId };
}

async function getIssueStatusName(
  db: ReturnType<typeof createTestDb>["db"],
  issueId: string,
): Promise<string> {
  const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
  const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
  return status.name;
}

// ─── Scenario A: drop AFTER mergedAt stamp ────────────────────────────────────

describe("merge-flap scenario A: drop after mergedAt stamped", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("retry with mergedAt already set reconciles issue to Done without re-running mergeBranch", async () => {
    const mergedAt = new Date(Date.now() - 5_000).toISOString();
    const { workspaceId, issueId } = await seedWorkspace(db, {
      mergedAt,
      status: "idle",
      readyForMerge: true,
    });

    const mergeBranch = vi.fn(async () => "Merge made by the 'ort' strategy.");
    const git = makeGit({ mergeBranch });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    const result = await svc.mergeWorkspace(workspaceId);

    // Must NOT call mergeBranch again — the git commit already landed
    expect(mergeBranch).not.toHaveBeenCalled();

    // Response signals already-merged reconciliation
    expect(result.mergeOutput).toMatch(/already marked as merged/i);

    // Issue must be Done after retry
    expect(await getIssueStatusName(db, issueId)).toBe("Done");

    // Workspace must be closed with mergedAt preserved
    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
    expect(ws.mergedAt).toBe(mergedAt);
  });

  it("issue stranded In Review is moved to Done on the retry call", async () => {
    // Simulate the exact board-monitor scenario: merge landed, response dropped,
    // issue is still In Review (finalizeMergeCleanup never ran).
    const mergedAt = new Date(Date.now() - 8_000).toISOString();
    const { workspaceId, issueId, inReviewStatusId } = await seedWorkspace(db, {
      mergedAt,
      status: "idle",
      readyForMerge: false,
    });

    // Confirm issue is still In Review before the retry
    const [issueBefore] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    expect(issueBefore.statusId).toBe(inReviewStatusId);

    const git = makeGit();
    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await svc.mergeWorkspace(workspaceId);

    expect(await getIssueStatusName(db, issueId)).toBe("Done");
  });

  it("second retry is also idempotent — mergedAt timestamp does not advance", async () => {
    const mergedAt = new Date(Date.now() - 3_000).toISOString();
    const { workspaceId, issueId } = await seedWorkspace(db, {
      mergedAt,
      status: "closed",
      readyForMerge: false,
    });

    const git = makeGit();
    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    // First retry
    await svc.mergeWorkspace(workspaceId);
    // Second retry
    await svc.mergeWorkspace(workspaceId);

    expect(await getIssueStatusName(db, issueId)).toBe("Done");

    const [ws] = await db.select({ mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    // mergedAt must not advance past the original stamp
    expect(ws.mergedAt).toBe(mergedAt);
  });
});

// ─── Scenario B: drop BEFORE mergedAt stamp, branch already ancestor ──────────

describe("merge-flap scenario B: drop before mergedAt stamp, branch landed as ancestor", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("reconciles to Done when branch is already an ancestor and mergedAt is null", async () => {
    const { workspaceId, issueId } = await seedWorkspace(db, {
      status: "idle",
      readyForMerge: true,
    });

    const mergeBranch = vi.fn(async () => "Merge made by the 'ort' strategy.");
    const git = makeGit({
      mergeBranch,
      // Branch is already an ancestor of master (git commit landed before crash)
      checkBranchTipIsAncestor: vi.fn(async () => ({
        isAncestor: true as const,
        branchSha: "feature-sha",
        baseSha: "merge-commit-sha",
      })),
      countUniqueCommits: vi.fn(async () => 3),
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    const result = await svc.mergeWorkspace(workspaceId);

    // Should reconcile without calling mergeBranch — already landed
    expect(mergeBranch).not.toHaveBeenCalled();
    expect(result.merged).toBe(false);
    expect(result.reconciled).toBe(true);

    expect(await getIssueStatusName(db, issueId)).toBe("Done");

    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
    expect(ws.mergedAt).toBeTruthy();
  });

  it("does not double-merge: mergeBranch is never called when branch tip is an ancestor", async () => {
    const { workspaceId } = await seedWorkspace(db, {
      status: "idle",
      readyForMerge: true,
    });

    const mergeBranch = vi.fn(async () => "should not be called");
    const git = makeGit({
      mergeBranch,
      checkBranchTipIsAncestor: vi.fn(async () => ({
        isAncestor: true as const,
        branchSha: "feature-sha",
        baseSha: "merge-commit-sha",
      })),
      countUniqueCommits: vi.fn(async () => 2),
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await svc.mergeWorkspace(workspaceId);
    expect(mergeBranch).not.toHaveBeenCalled();
  });
});

// ─── Scenario C: clean merge completes normally (happy-path regression guard) ─

describe("merge-flap happy path: clean merge sets mergedAt and moves issue to Done", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("first merge call: commits land, mergedAt stamped, issue moves to Done", async () => {
    const { workspaceId, issueId } = await seedWorkspace(db);

    const git = makeGit({
      // Before merge: branch is not yet ancestor
      checkBranchTipIsAncestor: (() => {
        let calls = 0;
        return vi.fn(async () => {
          calls++;
          if (calls === 1) return { isAncestor: false as const, branchSha: "feature-sha", baseSha: "master-sha" };
          return { isAncestor: true as const, branchSha: "feature-sha", baseSha: "merge-commit-sha" };
        });
      })(),
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    const result = await svc.mergeWorkspace(workspaceId);

    expect(result.merged).toBe(true);
    expect(await getIssueStatusName(db, issueId)).toBe("Done");

    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
    expect(ws.mergedAt).toBeTruthy();
  });
});
