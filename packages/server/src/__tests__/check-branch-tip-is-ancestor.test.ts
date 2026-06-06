/**
 * Unit tests for the checkBranchTipIsAncestor helper, exercised via the
 * workspace-merge service's injectable GitService interface.
 *
 * AC from ticket #549:
 *   - ancestor → reconcile-as-done (mergeWorkspace returns reconciled:true, checkAlreadyMerged returns true)
 *   - non-ancestor → needs-merge (checkAlreadyMerged returns false)
 *   - deleted-branch (revParse throws, no worktree) → checkAlreadyMerged returns false + reason
 *   - deleted-branch (revParse throws, worktreeDir provided) → falls back to worktree HEAD
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceMergeService } from "../services/workspace-merge.service.js";
import type { BranchTipAncestryResult } from "@agentic-kanban/shared/lib/git-service";

function makeGitService(
  checkBranchTipIsAncestor: (repo: string, branch: string, base: string, worktree?: string) => Promise<BranchTipAncestryResult>,
  countUniqueCommits: (_repo: string, _baseSha: string, _branchSha: string) => Promise<number> = async () => 1,
) {
  return {
    getDiff: vi.fn(async () => ""),
    getDiffFromRepo: vi.fn(async () => ""),
    revParse: vi.fn(async (_repo: string, ref: string) => ref),
    isAncestor: vi.fn(async () => false),
    checkBranchTipIsAncestor: vi.fn(checkBranchTipIsAncestor),
    countUniqueCommits: vi.fn(countUniqueCommits),
    removeWorktree: vi.fn(async () => {}),
    mergeBranch: vi.fn(async () => "Merge made by the 'ort' strategy."),
    detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
    syncBranchToHead: vi.fn(async () => false),
    deleteBranch: vi.fn(async () => {}),
    getChangedFilesBetween: vi.fn(async () => []),
    getCurrentBranch: vi.fn(async () => "master"),
    autoRenumberMigrations: vi.fn(async () => ({ renumbered: false, renames: [] })),
  };
}

async function seedScenario(db: ReturnType<typeof createTestDb>["db"], opts: {
  workingDir?: string | null;
  workspaceStatus?: string;
  readyForMerge?: boolean;
  baseCommitSha?: string | null;
} = {}) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: 549, title: "Test", priority: "medium",
    sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-549-test",
    workingDir: opts.workingDir !== undefined ? opts.workingDir : "/repo/.worktrees/ws",
    baseBranch: "master", isDirect: false,
    baseCommitSha: opts.baseCommitSha ?? null,
    status: opts.workspaceStatus ?? "idle",
    readyForMerge: opts.readyForMerge ?? false,
    provider: "claude", createdAt: now, updatedAt: now,
  });

  return { projectId, issueId, workspaceId };
}

describe("checkBranchTipIsAncestor helper — three AC paths", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("ancestor → checkAlreadyMerged returns isAlreadyMerged: true", async () => {
    const { workspaceId } = await seedScenario(db);
    const git = makeGitService(async () => ({ isAncestor: true, branchSha: "branch-sha", baseSha: "base-sha" }));

    const svc = createWorkspaceMergeService({ database: db, gitService: git as never, createBackup: async () => {} });
    const result = await svc.checkAlreadyMerged(workspaceId);

    expect(result.isAlreadyMerged).toBe(true);
    expect(result.branch).toBe("feature/ak-549-test");
    expect(result.baseBranch).toBe("master");
  });

  it("ancestor → mergeWorkspace reconciles as done without a real merge", async () => {
    const { workspaceId } = await seedScenario(db, { readyForMerge: true });
    const mergeBranch = vi.fn();
    const git = {
      ...makeGitService(async () => ({ isAncestor: true, branchSha: "branch-sha", baseSha: "base-sha" })),
      mergeBranch,
    };

    const svc = createWorkspaceMergeService({ database: db, gitService: git as never, createBackup: async () => {}, processKiller: async () => 0 });
    const result = await svc.mergeWorkspace(workspaceId);

    expect(result.merged).toBe(false);
    expect(result.reconciled).toBe(true);
    expect(mergeBranch).not.toHaveBeenCalled();
  });

  it("regression #583: 0-commit workspace (branchSha===baseSha) — mergeWorkspace does NOT reconcile as done", async () => {
    // A fresh workspace has 0 unique commits: countUniqueCommits returns 0.
    // Even though tip is trivially an ancestor, the reconciler must NOT auto-Done it.
    const { workspaceId } = await seedScenario(db, { readyForMerge: true, baseCommitSha: "sha-original-base" });
    const mergeBranch = vi.fn(async () => "Merge made by the 'ort' strategy.");
    const countUniqueCommits = vi.fn(async () => 0);
    const git = {
      ...makeGitService(async () => ({ isAncestor: true, branchSha: "sha-branch", baseSha: "sha-branch" }), countUniqueCommits),
      mergeBranch,
    };

    const svc = createWorkspaceMergeService({ database: db, gitService: git as never, createBackup: async () => {}, processKiller: async () => 0 });
    const result = await svc.mergeWorkspace(workspaceId);

    // Must not have been reconciled as already-done; the real merge runs instead
    expect(result.reconciled).toBeFalsy();
    expect(countUniqueCommits).toHaveBeenCalled();
  });

  it("regression #583: 0-commit workspace (base advanced) — mergeWorkspace does NOT reconcile as done", async () => {
    // Branch was created when base was at commitX; base later advanced to commitY.
    // Branch still has 0 unique commits. branchSha !== baseSha but countUniqueCommits returns 0.
    const { workspaceId } = await seedScenario(db, { readyForMerge: true, baseCommitSha: "sha-original-base" });
    const mergeBranch = vi.fn(async () => "Merge made by the 'ort' strategy.");
    const countUniqueCommits = vi.fn(async () => 0);
    const git = {
      ...makeGitService(async () => ({ isAncestor: true, branchSha: "sha-original-base", baseSha: "sha-current-base" }), countUniqueCommits),
      mergeBranch,
    };

    const svc = createWorkspaceMergeService({ database: db, gitService: git as never, createBackup: async () => {}, processKiller: async () => 0 });
    const result = await svc.mergeWorkspace(workspaceId);

    expect(result.reconciled).toBeFalsy();
    expect(countUniqueCommits).toHaveBeenCalled();
  });

  it("non-ancestor → checkAlreadyMerged returns isAlreadyMerged: false with reason", async () => {
    const { workspaceId } = await seedScenario(db);
    const git = makeGitService(async () => ({ isAncestor: false, branchSha: "branch-sha", baseSha: "base-sha" }));

    const svc = createWorkspaceMergeService({ database: db, gitService: git as never, createBackup: async () => {} });
    const result = await svc.checkAlreadyMerged(workspaceId);

    expect(result.isAlreadyMerged).toBe(false);
    expect(result.reason).toMatch(/reachable/i);
  });

  it("deleted branch (no worktree) → checkAlreadyMerged returns false with branch-not-found reason", async () => {
    const { workspaceId } = await seedScenario(db, { workingDir: null });
    const git = makeGitService(async () => ({ isAncestor: false as const, branchSha: null, reason: "branch-not-found" as const }));

    const svc = createWorkspaceMergeService({ database: db, gitService: git as never, createBackup: async () => {} });
    const result = await svc.checkAlreadyMerged(workspaceId);

    expect(result.isAlreadyMerged).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("deleted branch with worktree fallback → checkBranchTipIsAncestor called with worktreeDir", async () => {
    const { workspaceId } = await seedScenario(db, { workingDir: "/repo/.worktrees/ws" });
    const checkBranchTipIsAncestor = vi.fn(async (_repo: string, _branch: string, _base: string, _worktree?: string): Promise<BranchTipAncestryResult> =>
      ({ isAncestor: true, branchSha: "worktree-head-sha", baseSha: "base-sha" })
    );
    const git = { ...makeGitService(checkBranchTipIsAncestor), checkBranchTipIsAncestor };

    const svc = createWorkspaceMergeService({ database: db, gitService: git as never, createBackup: async () => {} });
    await svc.checkAlreadyMerged(workspaceId);

    expect(checkBranchTipIsAncestor).toHaveBeenCalledWith(
      "/repo",
      "feature/ak-549-test",
      "master",
      "/repo/.worktrees/ws",
    );
  });
});
