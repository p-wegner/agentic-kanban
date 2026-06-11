/**
 * Integration tests for merge service edge cases (#608):
 *   1. Conflict-marker spillover: mergeBranch throws → 409 with mergeReason=conflict
 *   2. 0-commit branch equal-to-base: NOT reconciled as Done (false positive guard)
 *   3. Stale readyForMerge cleared on rebase conflict: flag downgraded when branch
 *      is behind base and rebase reveals real content conflict
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceMergeService } from "../services/workspace-merge.service.js";

// ─── shared factory ──────────────────────────────────────────────────────────

function makeGit(overrides: Partial<Record<string, (...a: unknown[]) => unknown>> = {}) {
  return {
    getDiff: vi.fn(async () => ""),
    getDiffFromRepo: vi.fn(async () => ""),
    revParse: vi.fn(async (_repo: string, ref: string) => {
      if (ref === "HEAD") return "merge-sha";
      if (ref === "master") return "master-sha";
      return "branch-sha";
    }),
    isAncestor: vi.fn(async () => false),
    mergeBranch: vi.fn(async () => "Merge made by the 'ort' strategy."),
    detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
    detectConflictsByBranch: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
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
        // First call: pre-merge — not ancestor yet; second+: post-merge — merge landed
        if (calls === 1) return { isAncestor: false as const, branchSha: "branch-sha", baseSha: "master-sha" };
        return { isAncestor: true as const, branchSha: "branch-sha", baseSha: "merge-sha" };
      });
    })(),
    getUncommittedTrackedChanges: vi.fn(async () => []),
    countUniqueCommits: vi.fn(async () => 1),
    countBehindCommits: vi.fn(async () => 0),
    rebaseOntoBase: vi.fn(async () => ({ success: true })),
    mergeBaseIntoBranch: vi.fn(async () => ({ success: true })),
    abortRebase: vi.fn(async () => {}),
    ...overrides,
  };
}

async function seedWorkspace(
  db: ReturnType<typeof createTestDb>["db"],
  opts: { readyForMerge?: boolean; mergedAt?: string | null; status?: string } = {},
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
    issueNumber: 608,
    title: "Edge-case test issue",
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
    branch: "feature/ak-608-edge-case",
    workingDir: "/repo/.worktrees/feature_ak-608-edge-case",
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

// ─── Edge case 1: conflict-marker spillover ──────────────────────────────────
// mergeBranch() scans the computed merge tree for literal "<<<<<<<" markers.
// When it finds them (or detects stage-entry conflicts), it must throw so the
// HTTP endpoint returns 409 — not silently commit conflict markers to master.

describe("merge — conflict-marker spillover blocked (regression #598/#599/#600)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("throws CONFLICT with mergeReason=conflict when mergeBranch detects conflict markers", async () => {
    const { workspaceId } = await seedWorkspace(db);
    const git = makeGit({
      mergeBranch: async () => { throw new Error("Conflict markers found in merged tree: src/app.ts"); },
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await expect(svc.mergeWorkspace(workspaceId)).rejects.toMatchObject({
      code: "CONFLICT",
      data: { mergeReason: "conflict" },
    });
  });

  it("does NOT close the workspace or move the issue to Done when merge aborts on conflict markers", async () => {
    const { workspaceId, issueId } = await seedWorkspace(db);
    const git = makeGit({
      mergeBranch: async () => { throw new Error("Conflict markers found in merged tree: src/index.ts"); },
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    try {
      await svc.mergeWorkspace(workspaceId);
    } catch {
      // expected
    }

    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).not.toBe("closed");
    expect(ws.mergedAt).toBeNull();

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("In Review");
  });

  it("throws CONFLICT when read-only detection reports hasConflicts=true before the merge attempt", async () => {
    const { workspaceId } = await seedWorkspace(db);
    const git = makeGit({
      // Branch-level merge-tree runs before mergeBranch — simulates stage-entry conflict
      detectConflictsByBranch: async () => ({ hasConflicts: true, conflictingFiles: ["src/app.ts", "src/types.ts"] }),
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await expect(svc.mergeWorkspace(workspaceId)).rejects.toMatchObject({
      code: "CONFLICT",
      data: { mergeReason: "conflict" },
    });
  });

  it("conflict error body includes conflicting files list when read-only detection reports them", async () => {
    const { workspaceId } = await seedWorkspace(db);
    const conflictingFiles = ["packages/shared/src/schema.ts", "packages/server/src/routes/workspaces.ts"];
    const git = makeGit({
      detectConflictsByBranch: async () => ({ hasConflicts: true, conflictingFiles }),
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await expect(svc.mergeWorkspace(workspaceId)).rejects.toMatchObject({
      code: "CONFLICT",
      data: { conflictFiles: conflictingFiles },
    });
  });
});

// ─── Edge case 2: 0-commit branch equal-to-base ──────────────────────────────
// A workspace whose branch tip == base tip is "trivially an ancestor" but has
// NO merged work. The reconciler guard (countUniqueCommits==0) must prevent the
// merge endpoint from moving the issue to Done as a false positive.
// Regression: the ancestor-branch reconciler (#576) silently reaped these.

describe("merge — 0-commit branch is NOT reconciled as Done (false positive guard)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("does not mark the workspace closed or move issue to Done when branch has 0 unique commits", async () => {
    const { workspaceId, issueId } = await seedWorkspace(db);
    // Branch tip == base tip (trivially ancestor), but 0 unique commits
    const git = makeGit({
      checkBranchTipIsAncestor: vi.fn(async () => ({
        isAncestor: true as const,
        branchSha: "same-sha",
        baseSha: "same-sha",
      })),
      countUniqueCommits: vi.fn(async () => 0),
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    const result = await svc.mergeWorkspace(workspaceId);

    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    const [wsReady] = await db.select({ readyForMerge: workspaces.readyForMerge })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));

    expect(git.mergeBranch).not.toHaveBeenCalled();
    expect(result.merged).toBe(false);
    expect(result.reconciled).toBe(false);
    expect(ws.status).not.toBe("closed");
    expect(ws.mergedAt).toBeNull();
    expect(wsReady.readyForMerge).toBe(false);
    expect(status.name).toBe("In Review");
  });

  it("returns reconciled=true only when branch has >=1 unique commit AND tip is ancestor", async () => {
    const { workspaceId } = await seedWorkspace(db);
    const git = makeGit({
      checkBranchTipIsAncestor: vi.fn(async () => ({
        isAncestor: true as const,
        branchSha: "feature-sha",
        baseSha: "master-sha-ahead",
      })),
      countUniqueCommits: vi.fn(async () => 2),
      mergeBranch: vi.fn(async () => { throw new Error("should not be called"); }),
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    const result = await svc.mergeWorkspace(workspaceId);

    expect(result.reconciled).toBe(true);
    expect(result.merged).toBe(false);
    expect(git.mergeBranch).not.toHaveBeenCalled();
  });

  it("returns clean-ancestor no-op when 0-commit branch is reconciled as clean ancestor", async () => {
    // The 0-commit guard runs before normal merge.
    const { workspaceId, issueId } = await seedWorkspace(db);
    const git = makeGit({
      checkBranchTipIsAncestor: vi.fn().mockResolvedValueOnce({
        isAncestor: true as const,
        branchSha: "same-sha",
        baseSha: "same-sha",
      }),
      countUniqueCommits: vi.fn(async () => 0),
      mergeBranch: vi.fn(async () => { throw new Error("must not be called"); }),
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    const result = await svc.mergeWorkspace(workspaceId);

    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    const [wsReady] = await db.select({ readyForMerge: workspaces.readyForMerge })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));

    expect(ws.status).not.toBe("closed");
    expect(ws.mergedAt).toBeNull();
    expect(wsReady.readyForMerge).toBe(false);
    expect(result.merged).toBe(false);
    expect(result.reconciled).toBe(false);
    expect(git.mergeBranch).not.toHaveBeenCalled();
    expect(status.name).toBe("In Review");
  });
});

// ─── Edge case 3: stale readyForMerge cleared on rebase conflict ─────────────
// If the branch is N commits behind base and a pre-merge auto-rebase reveals real
// conflicts, the service MUST clear readyForMerge so the monitor stops churning on
// this workspace. Without this, auto-merge loops infinitely on a conflicting stale
// workspace that was approved against an older base.

describe("merge — stale readyForMerge cleared when behind-base rebase finds conflict", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("clears readyForMerge and throws CONFLICT when branch is behind and merge-tree conflicts", async () => {
    const { workspaceId } = await seedWorkspace(db, { readyForMerge: true });
    const git = makeGit({
      checkBranchTipIsAncestor: vi.fn(async () => ({
        isAncestor: false as const,
        branchSha: "branch-sha",
        baseSha: "master-sha",
      })),
      countBehindCommits: vi.fn(async () => 3),
      // Conflict is now surfaced read-only (no destructive rebase) — #761.
      detectConflictsByBranch: vi.fn(async () => ({
        hasConflicts: true,
        conflictingFiles: ["packages/shared/src/schema.ts"],
      })),
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await expect(svc.mergeWorkspace(workspaceId)).rejects.toMatchObject({
      code: "CONFLICT",
      data: { mergeReason: "conflict" },
    });

    // readyForMerge must be downgraded so auto-merge doesn't loop
    const [ws] = await db.select({ readyForMerge: workspaces.readyForMerge })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.readyForMerge).toBe(false);
  });

  it("includes behindCount and conflictFiles in the thrown error data", async () => {
    const { workspaceId } = await seedWorkspace(db, { readyForMerge: true });
    const conflictingFiles = ["packages/server/src/routes/workspaces.ts"];
    const git = makeGit({
      checkBranchTipIsAncestor: vi.fn(async () => ({
        isAncestor: false as const,
        branchSha: "branch-sha",
        baseSha: "master-sha",
      })),
      countBehindCommits: vi.fn(async () => 5),
      detectConflictsByBranch: vi.fn(async () => ({ hasConflicts: true, conflictingFiles })),
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await expect(svc.mergeWorkspace(workspaceId)).rejects.toMatchObject({
      code: "CONFLICT",
      data: { behindCount: 5, conflictFiles: conflictingFiles },
    });
  });

  it("does NOT clear readyForMerge when branch is NOT behind base (rebase never runs)", async () => {
    const { workspaceId } = await seedWorkspace(db, { readyForMerge: true });
    const git = makeGit({
      // Branch is current — no behind commits
      countBehindCommits: vi.fn(async () => 0),
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await svc.mergeWorkspace(workspaceId);

    const [ws] = await db.select({ readyForMerge: workspaces.readyForMerge })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    // readyForMerge is set to false by a SUCCESSFUL merge (cleanup), which is expected
    expect(ws.readyForMerge).toBe(false);
    // But the workspace IS closed (merge succeeded)
    const [wsStatus] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(wsStatus.status).toBe("closed");
  });

  it("never rebases the worktree during conflict detection when branch is behind (#761 read-only)", async () => {
    const { workspaceId } = await seedWorkspace(db, { readyForMerge: true });
    const rebaseOntoBase = vi.fn(async () => ({ success: false, conflictingFiles: [] }));
    const abortRebase = vi.fn(async () => {});
    const git = makeGit({
      checkBranchTipIsAncestor: vi.fn(async () => ({
        isAncestor: false as const,
        branchSha: "branch-sha",
        baseSha: "master-sha",
      })),
      countBehindCommits: vi.fn(async () => 2),
      detectConflictsByBranch: vi.fn(async () => ({ hasConflicts: true, conflictingFiles: ["src/app.ts"] })),
      rebaseOntoBase,
      abortRebase,
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    try { await svc.mergeWorkspace(workspaceId); } catch { /* expected */ }

    // The destructive in-place rebase was the root of the re-conflict loop — it must
    // not run during a /merge attempt, so repeated attempts converge.
    expect(rebaseOntoBase).not.toHaveBeenCalled();
    expect(abortRebase).not.toHaveBeenCalled();
  });

  it("workspace readyForMerge stays false after a behind-base conflict — merge endpoint never re-blocks on monitor loop", async () => {
    const { workspaceId } = await seedWorkspace(db, { readyForMerge: true });
    const git = makeGit({
      checkBranchTipIsAncestor: vi.fn(async () => ({
        isAncestor: false as const,
        branchSha: "branch-sha",
        baseSha: "master-sha",
      })),
      countBehindCommits: vi.fn(async () => 4),
      detectConflictsByBranch: vi.fn(async () => ({ hasConflicts: true, conflictingFiles: ["src/app.ts"] })),
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    // First call — fails and clears flag
    try { await svc.mergeWorkspace(workspaceId); } catch { /* expected */ }

    const [wsAfterFirst] = await db.select({ readyForMerge: workspaces.readyForMerge })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(wsAfterFirst.readyForMerge).toBe(false);

    // Second call — now blocked by not_approved, not by rebase conflict
    await expect(svc.mergeWorkspace(workspaceId)).rejects.toMatchObject({
      code: "CONFLICT",
      data: { mergeReason: "not_approved" },
    });
  });
});
