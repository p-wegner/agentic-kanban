import { describe, expect, it, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceMergeService } from "../services/workspace-merge.service.js";

// Minimal git service fake
function makeGitService(overrides: Partial<{
  getDiff: (dir: string, base: string) => Promise<string>;
  getDiffFromRepo: (repo: string, branch: string, base: string) => Promise<string>;
  revParse: (repo: string, ref: string) => Promise<string>;
  isAncestor: (repo: string, ancestor: string, descendant: string) => Promise<boolean>;
  removeWorktree: (repo: string, worktree: string) => Promise<void>;
}> = {}) {
  return {
    getDiff: vi.fn(overrides.getDiff ?? (async () => "")),
    getDiffFromRepo: vi.fn(overrides.getDiffFromRepo ?? (async () => "")),
    revParse: vi.fn(overrides.revParse ?? (async (_repo: string, ref: string) => ref === "HEAD" ? "abc123" : "abc123")),
    isAncestor: vi.fn(overrides.isAncestor ?? (async () => true)),
    removeWorktree: vi.fn(overrides.removeWorktree ?? (async () => {})),
    mergeBranch: vi.fn(async () => "Already up to date."),
    detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
    syncBranchToHead: vi.fn(async () => false),
    deleteBranch: vi.fn(async () => {}),
    getChangedFilesBetween: vi.fn(async () => []),
    getCurrentBranch: vi.fn(async () => "master"),
    autoRenumberMigrations: vi.fn(async () => ({ renumbered: false, renames: [] })),
  };
}

async function seedScenario(db: ReturnType<typeof createTestDb>["db"], opts: {
  workspaceStatus?: string;
  workingDir?: string | null;
  isDirect?: boolean;
  branch?: string;
}) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    name: "Test",
    repoPath: "/repo",
    repoName: "repo",
    defaultBranch: "master",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: statusId,
    projectId,
    name: "Done",
    sortOrder: 3,
    isDefault: false,
    createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId,
    issueNumber: 42,
    title: "Test issue",
    priority: "medium",
    sortOrder: 0,
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: opts.branch ?? "feature/ak-42-test",
    workingDir: opts.workingDir !== undefined ? opts.workingDir : "/repo/.worktrees/ws",
    baseBranch: "master",
    isDirect: opts.isDirect ?? false,
    status: opts.workspaceStatus ?? "idle",
    readyForMerge: false,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });

  return { projectId, issueId, workspaceId };
}

describe("checkAlreadyMerged", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("detects an already-merged workspace (no diff, commit reachable)", async () => {
    const { workspaceId } = await seedScenario(db, {});
    const git = makeGitService({
      getDiff: async () => "",
      revParse: async (_repo, ref) => ref === "feature/ak-42-test" ? "deadbeef" : "headsha",
      isAncestor: async () => true,
    });

    const svc = createWorkspaceMergeService({ database: db, gitService: git as never, createBackup: async () => {} });
    const result = await svc.checkAlreadyMerged(workspaceId);

    expect(result.isAlreadyMerged).toBe(true);
    expect(result.branch).toBe("feature/ak-42-test");
    expect(result.baseBranch).toBe("master");
    expect(result.issueNumber).toBe(42);
    expect(result.mergeCommitSha).toBeTruthy();
  });

  it("returns false when branch still has a real diff", async () => {
    const { workspaceId } = await seedScenario(db, {});
    const git = makeGitService({
      getDiff: async () => "diff --git a/foo.ts b/foo.ts\n+something",
      isAncestor: async () => false,
    });

    const svc = createWorkspaceMergeService({ database: db, gitService: git as never, createBackup: async () => {} });
    const result = await svc.checkAlreadyMerged(workspaceId);

    expect(result.isAlreadyMerged).toBe(false);
    expect(result.reason).toMatch(/diff/i);
  });

  it("returns false when commit is not reachable from base branch", async () => {
    const { workspaceId } = await seedScenario(db, {});
    const git = makeGitService({
      getDiff: async () => "",
      isAncestor: async () => false,
    });

    const svc = createWorkspaceMergeService({ database: db, gitService: git as never, createBackup: async () => {} });
    const result = await svc.checkAlreadyMerged(workspaceId);

    expect(result.isAlreadyMerged).toBe(false);
    expect(result.reason).toMatch(/reachable/i);
  });

  it("falls back to repo-level diff when worktree is missing", async () => {
    const { workspaceId } = await seedScenario(db, { workingDir: null });
    const getDiffFromRepo = vi.fn(async () => "");
    const git = makeGitService({ getDiffFromRepo, isAncestor: async () => true });

    const svc = createWorkspaceMergeService({ database: db, gitService: git as never, createBackup: async () => {} });
    const result = await svc.checkAlreadyMerged(workspaceId);

    expect(result.isAlreadyMerged).toBe(true);
    expect(getDiffFromRepo).toHaveBeenCalledWith("/repo", "feature/ak-42-test", "master");
  });

  it("throws NOT_FOUND for a missing workspace", async () => {
    const svc = createWorkspaceMergeService({ database: db, gitService: makeGitService() as never, createBackup: async () => {} });
    await expect(svc.checkAlreadyMerged("nonexistent-id")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("throws BAD_REQUEST for a direct workspace", async () => {
    const { workspaceId } = await seedScenario(db, { isDirect: true });
    const svc = createWorkspaceMergeService({ database: db, gitService: makeGitService() as never, createBackup: async () => {} });
    await expect(svc.checkAlreadyMerged(workspaceId)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("doMerge ancestry check", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("(a) already-merged branch tip => merge reports success, no 409", async () => {
    const { workspaceId } = await seedScenario(db, { workspaceStatus: "idle" });
    const detectConflicts = vi.fn(async () => ({ hasConflicts: true, conflictingFiles: ["Layout.tsx"] }));
    const git = {
      ...makeGitService({
        revParse: async (_repo: string, ref: string) => ref === "feature/ak-42-test" ? "ancestor-sha" : "target-sha",
        isAncestor: async () => true,
      }),
      detectConflicts,
    };

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });
    const result = await svc.mergeWorkspace(workspaceId);

    expect(result.mergeOutput).toMatch(/already.*merged|no-op/i);
    expect(detectConflicts).not.toHaveBeenCalled();
  });

  it("(b) truly conflicting unmerged branch => still 409", async () => {
    const { workspaceId } = await seedScenario(db, { workspaceStatus: "idle" });
    const detectConflicts = vi.fn(async () => ({ hasConflicts: true, conflictingFiles: ["Layout.tsx", "BoardStats.tsx"] }));
    const git = {
      ...makeGitService({
        revParse: async (_repo: string, ref: string) => ref === "feature/ak-42-test" ? "feature-sha" : "target-sha",
        isAncestor: async () => false,
      }),
      detectConflicts,
    };

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });
    await expect(svc.mergeWorkspace(workspaceId)).rejects.toMatchObject({
      message: "Merge conflicts detected",
      code: "BAD_REQUEST",
    });
    expect(detectConflicts).toHaveBeenCalled();
  });
});

describe("reconcileAlreadyMerged", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("closes the workspace and returns a confirmation summary", async () => {
    const { workspaceId } = await seedScenario(db, {});
    const git = makeGitService({ getDiff: async () => "", isAncestor: async () => true });

    const svc = createWorkspaceMergeService({ database: db, gitService: git as never, createBackup: async () => {} });
    const result = await svc.reconcileAlreadyMerged(workspaceId);

    expect(result.branch).toBe("feature/ak-42-test");
    expect(result.baseBranch).toBe("master");
    expect(result.issueNumber).toBe(42);
    expect(result.reconciledAt).toBeTruthy();
  });

  it("moves the issue to Done", async () => {
    const { workspaceId, issueId } = await seedScenario(db, {});
    const git = makeGitService({ getDiff: async () => "", isAncestor: async () => true });

    const svc = createWorkspaceMergeService({ database: db, gitService: git as never, createBackup: async () => {} });
    await svc.reconcileAlreadyMerged(workspaceId);

    const { issues: issuesTable } = await import("@agentic-kanban/shared/schema");
    const { eq } = await import("drizzle-orm");
    const [issue] = await db.select({ statusId: issuesTable.statusId }).from(issuesTable).where(eq(issuesTable.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");
  });

  it("rejects reconciliation when branch has a real diff", async () => {
    const { workspaceId } = await seedScenario(db, {});
    const git = makeGitService({ getDiff: async () => "diff content", isAncestor: async () => false });

    const svc = createWorkspaceMergeService({ database: db, gitService: git as never, createBackup: async () => {} });
    await expect(svc.reconcileAlreadyMerged(workspaceId)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects reconciliation when workspace is already closed", async () => {
    const { workspaceId } = await seedScenario(db, { workspaceStatus: "closed" });
    const git = makeGitService();

    const svc = createWorkspaceMergeService({ database: db, gitService: git as never, createBackup: async () => {} });
    await expect(svc.reconcileAlreadyMerged(workspaceId)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("attempts to remove the worktree as best-effort cleanup", async () => {
    const { workspaceId } = await seedScenario(db, { workingDir: "/repo/.worktrees/ws" });
    const removeWorktree = vi.fn(async () => {});
    const git = makeGitService({ getDiff: async () => "", isAncestor: async () => true, removeWorktree });

    const svc = createWorkspaceMergeService({ database: db, gitService: git as never, createBackup: async () => {} });
    await svc.reconcileAlreadyMerged(workspaceId);

    expect(removeWorktree).toHaveBeenCalledWith("/repo", "/repo/.worktrees/ws");
  });
});
