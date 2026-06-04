/**
 * Tests for the merge endpoint ancestor-reconcile no-op path.
 *
 * The board monitor frequently calls POST /workspaces/:id/merge on zero-commit
 * workspaces that were already merged by a previous run but whose DB status was
 * never updated. When the branch tip is already an ancestor of the default branch,
 * the endpoint must: return HTTP 200, signal a reconciled no-op in the body, move
 * the issue to Done, and NOT create a new merge commit on master.
 *
 * This file focuses on the four explicit acceptance criteria from ticket #492.
 * Complementary lower-level tests live in workspace-already-merged.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceMergeService } from "../services/workspace-merge.service.js";

function makeGitService(overrides: Partial<{
  getDiff: (dir: string, base: string) => Promise<string>;
  getDiffFromRepo: (repo: string, branch: string, base: string) => Promise<string>;
  revParse: (repo: string, ref: string) => Promise<string>;
  isAncestor: (repo: string, ancestor: string, descendant: string) => Promise<boolean>;
  removeWorktree: (repo: string, worktree: string) => Promise<void>;
  mergeBranch: (repo: string, branch: string, targetBranch: string) => Promise<string>;
}> = {}) {
  return {
    getDiff: vi.fn(overrides.getDiff ?? (async () => "")),
    getDiffFromRepo: vi.fn(overrides.getDiffFromRepo ?? (async () => "")),
    revParse: vi.fn(overrides.revParse ?? (async (_repo: string, ref: string) => ref)),
    isAncestor: vi.fn(overrides.isAncestor ?? (async () => false)),
    removeWorktree: vi.fn(overrides.removeWorktree ?? (async () => {})),
    mergeBranch: vi.fn(overrides.mergeBranch ?? (async () => "Merge made by the 'ort' strategy.")),
    detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
    syncBranchToHead: vi.fn(async () => false),
    deleteBranch: vi.fn(async () => {}),
    getChangedFilesBetween: vi.fn(async () => []),
    getCurrentBranch: vi.fn(async () => "master"),
    autoRenumberMigrations: vi.fn(async () => ({ renumbered: false, renames: [] })),
  };
}

async function seedScenario(db: ReturnType<typeof createTestDb>["db"]) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const todoStatusId = randomUUID();
  const doneStatusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    name: "Test Project",
    repoPath: "/repo",
    repoName: "repo",
    defaultBranch: "master",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    {
      id: todoStatusId,
      projectId,
      name: "In Review",
      sortOrder: 2,
      isDefault: false,
      createdAt: now,
    },
    {
      id: doneStatusId,
      projectId,
      name: "Done",
      sortOrder: 3,
      isDefault: false,
      createdAt: now,
    },
  ]);
  await db.insert(issues).values({
    id: issueId,
    issueNumber: 492,
    title: "Test reconcile issue",
    priority: "medium",
    sortOrder: 0,
    statusId: todoStatusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/ak-492-test",
    workingDir: "/repo/.worktrees/feature_ak-492-test",
    baseBranch: "master",
    isDirect: false,
    status: "idle",
    readyForMerge: true,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });

  return { projectId, issueId, workspaceId, doneStatusId, todoStatusId };
}

describe("merge endpoint — already-merged-ancestor reconcile no-op path", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("(a) returns HTTP 200 when branch tip is already an ancestor of master", async () => {
    const { workspaceId } = await seedScenario(db);
    const git = makeGitService({
      revParse: async (_repo, ref) => ref === "feature/ak-492-test" ? "ancestor-sha" : "master-sha",
      isAncestor: async () => true,
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    // mergeWorkspace resolving (not throwing) is equivalent to HTTP 200 from the route
    const result = await svc.mergeWorkspace(workspaceId);
    expect(result).toBeDefined();
    expect(result.id).toBe(workspaceId);
  });

  it("(b) response body indicates a reconciled no-op (not a real merge)", async () => {
    const { workspaceId } = await seedScenario(db);
    const git = makeGitService({
      revParse: async (_repo, ref) => ref === "feature/ak-492-test" ? "ancestor-sha" : "master-sha",
      isAncestor: async () => true,
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });
    const result = await svc.mergeWorkspace(workspaceId);

    expect(result.mergeOutput).toMatch(/already fully merged|no-op/i);
    expect(result.mergeOutput).toContain("Reconciled as successful no-op");
  });

  it("(b2) reconcile no-op response shape: merged=false, reconciled=true, baseBranch, baseHeadSha*", async () => {
    const { workspaceId } = await seedScenario(db);
    const git = makeGitService({
      revParse: async (_repo, ref) => ref === "feature/ak-492-test" ? "ancestor-sha" : "master-sha-abc",
      isAncestor: async () => true,
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });
    const result = await svc.mergeWorkspace(workspaceId);

    expect(result.merged).toBe(false);
    expect(result.reconciled).toBe(true);
    expect(result.baseBranch).toBe("master");
    expect(result.baseHeadShaBefore).toBe("master-sha-abc");
    expect(result.baseHeadShaAfter).toBe("master-sha-abc");
  });

  it("(c) issue transitions to Done after ancestor reconcile", async () => {
    const { workspaceId, issueId } = await seedScenario(db);
    const git = makeGitService({
      revParse: async (_repo, ref) => ref === "feature/ak-492-test" ? "ancestor-sha" : "master-sha",
      isAncestor: async () => true,
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });
    await svc.mergeWorkspace(workspaceId);

    const [issue] = await db.select({ statusId: issues.statusId })
      .from(issues)
      .where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name })
      .from(projectStatuses)
      .where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");
  });

  it("(d) NO new merge commit created on master — mergeBranch is not called", async () => {
    const { workspaceId } = await seedScenario(db);
    const mergeBranch = vi.fn(async () => "Merge made by the 'ort' strategy.");
    const git = makeGitService({
      revParse: async (_repo, ref) => ref === "feature/ak-492-test" ? "ancestor-sha" : "master-sha",
      isAncestor: async () => true,
      mergeBranch,
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

  it("contrast: branch with real un-merged commits still invokes mergeBranch", async () => {
    const { workspaceId } = await seedScenario(db);
    const mergeBranch = vi.fn(async () => "Merge made by the 'ort' strategy.");
    const git = makeGitService({
      revParse: async (_repo, ref) => ref === "feature/ak-492-test" ? "feature-sha" : "master-sha",
      isAncestor: async () => false,
      mergeBranch,
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });
    await svc.mergeWorkspace(workspaceId);

    expect(mergeBranch).toHaveBeenCalled();
  });

  it("real merge response shape: merged=true, baseBranch, mergeCommitSha, baseHeadShaBefore, baseHeadShaAfter", async () => {
    const { workspaceId } = await seedScenario(db);
    let callCount = 0;
    const git = makeGitService({
      revParse: async (_repo, ref) => {
        if (ref === "feature/ak-492-test") return "feature-sha";
        if (ref === "master") return "master-sha-before";
        // HEAD is called twice: once pre-merge (returns before-sha), once post-merge (returns merge-commit-sha)
        callCount++;
        return callCount === 1 ? "master-sha-before" : "merge-commit-sha";
      },
      isAncestor: async () => false,
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });
    const result = await svc.mergeWorkspace(workspaceId);

    expect(result.merged).toBe(true);
    expect(result.baseBranch).toBe("master");
    expect(result.mergeCommitSha).toBeDefined();
    expect(result.baseHeadShaBefore).toBeDefined();
    expect(result.baseHeadShaAfter).toBeDefined();
  });
});
