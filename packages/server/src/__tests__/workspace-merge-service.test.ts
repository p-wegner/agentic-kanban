/**
 * Unit tests for the extracted WorkspaceMergeService.
 * Covers the three acceptance-criteria paths from ticket #548:
 *   1. Clean merge: advances the base branch, workspace closes, issue moves to Done.
 *   2. Already-merged (tip is ancestor): reconciles as no-op instead of throwing 409.
 *   3. Idempotency on retry: mergedAt workspace returns a deterministic 409 body.
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
      if (ref === "feature/ak-548-test") return "feature-sha";
      if (ref === "master") return "master-sha-before";
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
    ...overrides,
  };
}

async function seedWorkspace(
  db: ReturnType<typeof createTestDb>["db"],
  opts: { readyForMerge?: boolean; mergedAt?: string } = {},
) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const inReviewStatusId = randomUUID();
  const doneStatusId = randomUUID();
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
  await db.insert(projectStatuses).values([
    { id: inReviewStatusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now },
    { id: doneStatusId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
  ]);
  await db.insert(issues).values({
    id: issueId,
    issueNumber: 548,
    title: "Test issue",
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
    branch: "feature/ak-548-test",
    workingDir: "/repo/.worktrees/feature_ak-548-test",
    baseBranch: "master",
    isDirect: false,
    status: opts.mergedAt ? "closed" : "idle",
    readyForMerge: opts.readyForMerge ?? true,
    mergedAt: opts.mergedAt ?? null,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });

  return { projectId, issueId, workspaceId, doneStatusId };
}

// ─── Path 1: clean merge ────────────────────────────────────────────────────

describe("MergeService — clean merge advances base", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("calls mergeBranch and returns merged=true with SHAs", async () => {
    const { workspaceId } = await seedWorkspace(db);
    let headCallCount = 0;
    const git = makeGit({
      revParse: async (_repo: string, ref: string) => {
        if (ref === "feature/ak-548-test") return "feature-sha";
        if (ref === "master") return "master-sha-before";
        headCallCount++;
        return headCallCount === 1 ? "master-sha-before" : "merge-commit-sha";
      },
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });
    const result = await svc.mergeWorkspace(workspaceId);

    expect(git.mergeBranch).toHaveBeenCalledWith("/repo", "feature/ak-548-test", "master");
    expect(result.merged).toBe(true);
    expect(result.baseBranch).toBe("master");
    expect(result.mergeOutput).toContain("ort");
    expect(result.baseHeadShaBefore).toBeDefined();
    expect(result.baseHeadShaAfter).toBeDefined();
  });

  it("closes the workspace and moves the issue to Done after a clean merge", async () => {
    const { workspaceId, issueId } = await seedWorkspace(db);
    const git = makeGit();

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });
    await svc.mergeWorkspace(workspaceId);

    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
    expect(ws.mergedAt).toBeTruthy();

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");
  });
});

// ─── Path 2: already-merged (tip is ancestor) ───────────────────────────────

describe("MergeService — already-merged tip reconciles as no-op", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("returns reconciled=true and does NOT call mergeBranch", async () => {
    const { workspaceId } = await seedWorkspace(db);
    const mergeBranch = vi.fn(async () => "Merge made by the 'ort' strategy.");
    const git = makeGit({
      revParse: async (_repo: string, ref: string) => ref === "feature/ak-548-test" ? "ancestor-sha" : "master-sha",
      isAncestor: async () => true,
      mergeBranch,
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });
    const result = await svc.mergeWorkspace(workspaceId);

    expect(mergeBranch).not.toHaveBeenCalled();
    expect(result.merged).toBe(false);
    expect(result.reconciled).toBe(true);
    expect(result.mergeOutput).toMatch(/already fully merged|no-op/i);
  });

  it("moves the issue to Done even on no-op reconcile", async () => {
    const { workspaceId, issueId } = await seedWorkspace(db);
    const git = makeGit({
      revParse: async (_repo: string, ref: string) => ref === "feature/ak-548-test" ? "ancestor-sha" : "master-sha",
      isAncestor: async () => true,
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });
    await svc.mergeWorkspace(workspaceId);

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");
  });
});

// ─── Path 3: dropped-response idempotency on retry ──────────────────────────

describe("MergeService — idempotency: retry after dropped response", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("throws CONFLICT with mergeReason=already_merged when mergedAt is set (dropped-response retry)", async () => {
    const now = new Date().toISOString();
    const { workspaceId } = await seedWorkspace(db, { mergedAt: now });
    const git = makeGit();

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await expect(svc.mergeWorkspace(workspaceId)).rejects.toMatchObject({
      code: "CONFLICT",
      data: { mergeReason: "already_merged" },
    });
  });

  it("does not call mergeBranch on a dropped-response retry", async () => {
    const now = new Date().toISOString();
    const { workspaceId } = await seedWorkspace(db, { mergedAt: now });
    const mergeBranch = vi.fn(async () => "Merge made by the 'ort' strategy.");
    const git = makeGit({ mergeBranch });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await expect(svc.mergeWorkspace(workspaceId)).rejects.toThrow();
    expect(mergeBranch).not.toHaveBeenCalled();
  });
});
