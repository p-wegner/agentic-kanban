/**
 * Regression tests for workspace lifecycle transitions — ticket #609.
 *
 * Covers the full Done-status path:
 *   In Review → Done (clean merge)
 *   In Review → Done (branch already fully merged — tip is ancestor)
 *   In Review → Done (mergedAt already set — dropped-response idempotency)
 *   In Review stays In Review after post-merge ancestry invariant violation
 *   No-diff workspace (0 unique commits) — NOT reconciled as merged
 *
 * These tests guard against "Done-but-unmerged" regressions where an issue
 * appears Done in the UI but its branch was never actually landed on master.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { createWorkspaceMergeService } from "../services/workspace-merge.service.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeGit(overrides: Partial<Record<string, (...a: unknown[]) => unknown>> = {}) {
  return {
    getDiff: vi.fn(async () => ""),
    getDiffFromRepo: vi.fn(async () => ""),
    revParse: vi.fn(async (_repo: string, ref: string) => {
      if (ref === "feature/ak-609-test") return "feature-sha";
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
    checkBranchTipIsAncestor: (() => {
      let calls = 0;
      return vi.fn(async () => {
        calls++;
        // First call: pre-merge — branch not yet an ancestor of master
        // Second+ call: post-merge — merge landed, branch tip is now reachable from master
        if (calls === 1) return { isAncestor: false as const, branchSha: "feature-sha", baseSha: "master-sha" };
        return { isAncestor: true as const, branchSha: "feature-sha", baseSha: "merge-commit-sha" };
      });
    })(),
    getUncommittedTrackedChanges: vi.fn(async () => []),
    countUniqueCommits: vi.fn(async () => 1),
    rebaseOntoBase: vi.fn(async () => ({ success: true })),
    mergeBaseIntoBranch: vi.fn(async () => ({ success: true })),
    ...overrides,
  };
}

async function seedScenario(
  db: ReturnType<typeof createTestDb>["db"],
  opts: {
    issueStatus?: "in_review" | "done";
    workspaceStatus?: string;
    readyForMerge?: boolean;
    mergedAt?: string | null;
    branch?: string;
  } = {},
) {
  const now = new Date(Date.now() - 60_000).toISOString();
  const projectId = randomUUID();
  const inReviewStatusId = randomUUID();
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
    { id: inReviewStatusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now },
    { id: doneStatusId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
  ]);

  const initialStatusId = opts.issueStatus === "done" ? doneStatusId : inReviewStatusId;

  await db.insert(issues).values({
    id: issueId,
    issueNumber: 609,
    title: "Regression test issue",
    priority: "medium",
    sortOrder: 0,
    statusId: initialStatusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: opts.branch ?? "feature/ak-609-test",
    workingDir: "/repo/.worktrees/feature_ak-609-test",
    baseBranch: "master",
    isDirect: false,
    status: opts.workspaceStatus ?? (opts.mergedAt ? "closed" : "idle"),
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

// ─── Clean merge: In Review → Done ──────────────────────────────────────────

describe("lifecycle: In Review → Done via clean merge", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("moves issue from In Review to Done after a clean merge", async () => {
    const { workspaceId, issueId } = await seedScenario(db);
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

  it("closes workspace and sets mergedAt after a clean merge", async () => {
    const { workspaceId } = await seedScenario(db);
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
  });

  it("returns merged=true with the correct baseBranch and SHAs", async () => {
    const { workspaceId } = await seedScenario(db);
    const git = makeGit();

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });
    const result = await svc.mergeWorkspace(workspaceId);

    expect(result.merged).toBe(true);
    expect(result.baseBranch).toBe("master");
    expect(result.baseHeadShaBefore).toBeDefined();
    expect(result.baseHeadShaAfter).toBeDefined();
  });
});

// ─── Already-merged path: tip is ancestor → no-op Done ──────────────────────

describe("lifecycle: In Review → Done when branch already landed (tip is ancestor)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("moves issue to Done when branch tip is already an ancestor of master", async () => {
    const { workspaceId, issueId } = await seedScenario(db);
    const git = makeGit({
      checkBranchTipIsAncestor: vi.fn(async () => ({
        isAncestor: true as const,
        branchSha: "feature-sha",
        baseSha: "master-sha",
      })),
      countUniqueCommits: vi.fn(async () => 1),
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });
    await svc.mergeWorkspace(workspaceId);

    expect(await getIssueStatusName(db, issueId)).toBe("Done");
  });

  it("closes workspace on already-merged reconcile without calling mergeBranch", async () => {
    const { workspaceId } = await seedScenario(db);
    const mergeBranch = vi.fn(async () => "Merge made by the 'ort' strategy.");
    const git = makeGit({
      checkBranchTipIsAncestor: vi.fn(async () => ({
        isAncestor: true as const,
        branchSha: "feature-sha",
        baseSha: "master-sha",
      })),
      countUniqueCommits: vi.fn(async () => 1),
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

    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
    expect(ws.mergedAt).toBeTruthy();
  });

  it("returns reconciled=true when tip was already an ancestor", async () => {
    const { workspaceId } = await seedScenario(db);
    const git = makeGit({
      checkBranchTipIsAncestor: vi.fn(async () => ({
        isAncestor: true as const,
        branchSha: "feature-sha",
        baseSha: "master-sha",
      })),
      countUniqueCommits: vi.fn(async () => 1),
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
  });
});

// ─── No-diff workspace: 0 unique commits — not reconciled as merged ──────────

describe("lifecycle: 0-unique-commit workspace is NOT silently moved to Done", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("does NOT reconcile as merged when branch is ancestor with 0 unique commits", async () => {
    const { workspaceId, issueId } = await seedScenario(db);

    // Branch tip is an ancestor (tip==base or empty branch), but no actual commits.
    // The guard should bypass reconciliation and fall through to the real merge path.
    const git = makeGit({
      checkBranchTipIsAncestor: vi.fn(async () => {
        // Both pre- and post-merge checks: branch IS ancestor but has 0 unique commits
        return { isAncestor: true as const, branchSha: "base-sha", baseSha: "base-sha" };
      }),
      countUniqueCommits: vi.fn(async () => 0),
      // Make mergeBranch succeed and post-merge check also pass to let it complete
      mergeBranch: vi.fn(async () => "Already up to date."),
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    const result = await svc.mergeWorkspace(workspaceId);

    expect(result.merged).toBe(true);
    expect(git.countUniqueCommits).toHaveBeenCalled();
    expect(git.mergeBranch).toHaveBeenCalled();

    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
    expect(ws.mergedAt).toBeTruthy();
    expect(await getIssueStatusName(db, issueId)).toBe("Done");
  });

  it("issue remains In Review when no-diff branch cannot be merged (conflict guard)", async () => {
    const { workspaceId, issueId } = await seedScenario(db);

    const git = makeGit({
      // Branch appears NOT an ancestor on pre-merge check
      checkBranchTipIsAncestor: vi.fn(async () => ({
        isAncestor: false as const,
        branchSha: "feature-sha",
        baseSha: "master-sha",
      })),
      detectConflicts: vi.fn(async () => ({ hasConflicts: true, conflictingFiles: ["src/conflict.ts"] })),
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await expect(svc.mergeWorkspace(workspaceId)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    expect(await getIssueStatusName(db, issueId)).toBe("In Review");
  });
});

// ─── Post-merge ancestry invariant: blocks Done on merge anomaly ─────────────

describe("lifecycle: post-merge ancestry invariant blocks Done transition (#588)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("throws CONFLICT and does NOT move issue to Done when post-merge ancestry check fails", async () => {
    const { workspaceId, issueId } = await seedScenario(db);

    const git = makeGit({
      // Both pre- and post-merge: branch is never an ancestor (anomalous merge)
      checkBranchTipIsAncestor: vi.fn(async () => ({
        isAncestor: false as const,
        branchSha: "feature-sha",
        baseSha: "master-sha",
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
      data: expect.objectContaining({ mergeReason: "post_merge_ancestry_check_failed" }),
    });

    expect(await getIssueStatusName(db, issueId)).toBe("In Review");
  });

  it("workspace stays open (not closed) when post-merge ancestry invariant is violated", async () => {
    const { workspaceId } = await seedScenario(db);

    const git = makeGit({
      checkBranchTipIsAncestor: vi.fn(async () => ({
        isAncestor: false as const,
        branchSha: "feature-sha",
        baseSha: "master-sha",
      })),
    });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await expect(svc.mergeWorkspace(workspaceId)).rejects.toThrow();

    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).not.toBe("closed");
    expect(ws.mergedAt).toBeNull();
  });
});

// ─── mergedAt set path: dropped-response → idempotent reopen path ───────────────

describe("lifecycle: mergedAt already set — workspace moved to Done, retry is idempotent", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("moves issue to Done when mergedAt is already set (cleanup reconcile path)", async () => {
    const mergedAt = new Date(Date.now() - 5_000).toISOString();
    const { workspaceId, issueId } = await seedScenario(db, { mergedAt, workspaceStatus: "idle" });
    const git = makeGit();

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    // mergedAt set but workspace not yet closed — the cleanup path should close and Done it.
    await svc.mergeWorkspace(workspaceId);

    expect(await getIssueStatusName(db, issueId)).toBe("Done");

    const [ws] = await db.select({ status: workspaces.status })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
  });

  it("reconciles when workspace is already closed+mergedAt", async () => {
    const mergedAt = new Date(Date.now() - 5_000).toISOString();
    const { workspaceId, issueId } = await seedScenario(db, {
      mergedAt,
      workspaceStatus: "closed",
      readyForMerge: false,
    });
    const git = makeGit();

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    const result = await svc.mergeWorkspace(workspaceId);
    expect(result.mergeOutput).toContain("already recorded");

    expect(await getIssueStatusName(db, issueId)).toBe("Done");

    const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
  });

  it("does not call mergeBranch when workspace is already closed+mergedAt", async () => {
    const mergedAt = new Date(Date.now() - 5_000).toISOString();
    const { workspaceId } = await seedScenario(db, {
      mergedAt,
      workspaceStatus: "closed",
      readyForMerge: false,
    });
    const mergeBranch = vi.fn(async () => "Merge made by the 'ort' strategy.");
    const git = makeGit({ mergeBranch });

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await expect(svc.mergeWorkspace(workspaceId)).resolves.toBeDefined();
    expect(mergeBranch).not.toHaveBeenCalled();
  });
});

// ─── Not-approved guard: issue stays In Review ───────────────────────────────

describe("lifecycle: not-approved workspace cannot be merged", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("throws CONFLICT with mergeReason=not_approved when readyForMerge is false", async () => {
    const { workspaceId, issueId } = await seedScenario(db, { readyForMerge: false });
    const git = makeGit();

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await expect(svc.mergeWorkspace(workspaceId)).rejects.toMatchObject({
      code: "CONFLICT",
      data: { mergeReason: "not_approved" },
    });

    expect(await getIssueStatusName(db, issueId)).toBe("In Review");
  });
});
