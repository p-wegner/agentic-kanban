/**
 * Unit tests for classifyUnmergedWorkspaces (#1177).
 *
 * Reproduces the measured defect: `list_workspaces`/board "unmerged" counting is just
 * `status !== 'closed'`, so a workspace with no branch at all, or a branch that is 0
 * commits ahead of base (already landed), is counted the same as a workspace with real,
 * unlanded work. This classifier separates the three cases via git instead of trusting
 * the DB status alone.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import {
  classifyUnmergedWorkspaces,
  summarizeUnmergedWorkspaceBuckets,
  outstandingUnmergedWorkspaces,
} from "../services/workspace-unmerged-classification.service.js";
import type { BranchTipAncestryResult } from "@agentic-kanban/shared/lib/git-service";

type CheckAncestor = (repoPath: string, branch: string, baseBranch: string, worktreeDir?: string) => Promise<BranchTipAncestryResult>;
type CountCommits = (repoPath: string, baseSha: string, branchSha: string) => Promise<number>;

/** A fake ancestor-check keyed by branch name, so one test can seed several workspaces
 * with different branch states in a single project. */
function makeCheckAncestor(byBranch: Record<string, BranchTipAncestryResult>): CheckAncestor {
  return async (_repo, branch) => {
    const result = byBranch[branch];
    if (!result) throw new Error(`unexpected branch in test: ${branch}`);
    return result;
  };
}

function makeCountCommits(byBranchSha: Record<string, number>): CountCommits {
  return async (_repo, _baseSha, branchSha) => byBranchSha[branchSha] ?? 0;
}

async function seedProject(db: ReturnType<typeof createTestDb>["db"]) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
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
    name: "In Progress",
    sortOrder: 1,
    isDefault: false,
    createdAt: now,
  });
  return { projectId, statusId };
}

async function seedWorkspace(
  db: ReturnType<typeof createTestDb>["db"],
  opts: {
    projectId: string;
    statusId: string;
    issueNumber: number;
    branch: string;
    wsStatus?: string;
    isDirect?: boolean;
    baseBranch?: string | null;
  },
) {
  const now = new Date().toISOString();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(issues).values({
    id: issueId,
    issueNumber: opts.issueNumber,
    title: `Issue ${opts.issueNumber}`,
    priority: "medium",
    sortOrder: 0,
    statusId: opts.statusId,
    projectId: opts.projectId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: opts.branch,
    workingDir: "/repo/.worktrees/ws",
    baseBranch: opts.baseBranch === undefined ? "master" : opts.baseBranch,
    isDirect: opts.isDirect ?? false,
    status: opts.wsStatus ?? "idle",
    readyForMerge: false,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });
  return { issueId, workspaceId };
}

describe("classifyUnmergedWorkspaces", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("classifies a workspace with no branch as no-branch", async () => {
    const { projectId, statusId } = await seedProject(db);
    await seedWorkspace(db, { projectId, statusId, issueNumber: 98, branch: "feature/ak-98-gone" });

    const checkAncestor = makeCheckAncestor({
      "feature/ak-98-gone": { isAncestor: false, branchSha: null, reason: "branch-not-found" },
    });

    const report = await classifyUnmergedWorkspaces(projectId, { database: db, checkAncestor });

    expect(report.classifications).toHaveLength(1);
    expect(report.classifications[0].bucket).toBe("no-branch");
    expect(report.acted).toBe(1);
    expect(report.skipped).toBe(0);
  });

  it("classifies a branch that is an ancestor of base (0 ahead) as zero-ahead", async () => {
    const { projectId, statusId } = await seedProject(db);
    await seedWorkspace(db, { projectId, statusId, issueNumber: 139, branch: "feature/ak-139-landed" });

    const checkAncestor = makeCheckAncestor({
      "feature/ak-139-landed": { isAncestor: true, branchSha: "sha-branch", baseSha: "sha-base" },
    });

    const report = await classifyUnmergedWorkspaces(projectId, { database: db, checkAncestor });

    expect(report.classifications).toHaveLength(1);
    expect(report.classifications[0].bucket).toBe("zero-ahead");
    expect(report.classifications[0].uniqueCommitCount).toBe(0);
  });

  it("classifies a diverged branch with 0 unique commits as zero-ahead (not outstanding)", async () => {
    const { projectId, statusId } = await seedProject(db);
    await seedWorkspace(db, { projectId, statusId, issueNumber: 462, branch: "feature/ak-462-diverged" });

    const checkAncestor = makeCheckAncestor({
      "feature/ak-462-diverged": { isAncestor: false, branchSha: "sha-branch", baseSha: "sha-base" },
    });
    const countCommits = makeCountCommits({ "sha-branch": 0 });

    const report = await classifyUnmergedWorkspaces(projectId, { database: db, checkAncestor, countCommits });

    expect(report.classifications[0].bucket).toBe("zero-ahead");
  });

  it("classifies a branch with real unique commits as outstanding", async () => {
    const { projectId, statusId } = await seedProject(db);
    await seedWorkspace(db, { projectId, statusId, issueNumber: 500, branch: "feature/ak-500-real" });

    const checkAncestor = makeCheckAncestor({
      "feature/ak-500-real": { isAncestor: false, branchSha: "sha-branch", baseSha: "sha-base" },
    });
    const countCommits = makeCountCommits({ "sha-branch": 4 });

    const report = await classifyUnmergedWorkspaces(projectId, { database: db, checkAncestor, countCommits });

    expect(report.classifications[0].bucket).toBe("outstanding");
    expect(report.classifications[0].uniqueCommitCount).toBe(4);
  });

  it("reproduces the ~2.5x inflation: 54 unmerged split into the measured buckets", async () => {
    const { projectId, statusId } = await seedProject(db);
    const byBranch: Record<string, BranchTipAncestryResult> = {};
    const byBranchSha: Record<string, number> = {};

    let issueNumber = 1;
    // 15 no-branch
    for (let i = 0; i < 15; i++) {
      const branch = `feature/ak-${issueNumber++}-no-branch`;
      await seedWorkspace(db, { projectId, statusId, issueNumber, branch });
      byBranch[branch] = { isAncestor: false, branchSha: null, reason: "branch-not-found" };
    }
    // 18 zero-ahead
    for (let i = 0; i < 18; i++) {
      const branch = `feature/ak-${issueNumber++}-zero-ahead`;
      await seedWorkspace(db, { projectId, statusId, issueNumber, branch });
      byBranch[branch] = { isAncestor: true, branchSha: `sha-${branch}`, baseSha: "sha-base" };
    }
    // 21 real outstanding
    for (let i = 0; i < 21; i++) {
      const branch = `feature/ak-${issueNumber++}-outstanding`;
      await seedWorkspace(db, { projectId, statusId, issueNumber, branch });
      byBranch[branch] = { isAncestor: false, branchSha: `sha-${branch}`, baseSha: "sha-base" };
      byBranchSha[`sha-${branch}`] = 2;
    }

    const report = await classifyUnmergedWorkspaces(projectId, {
      database: db,
      checkAncestor: makeCheckAncestor(byBranch),
      countCommits: makeCountCommits(byBranchSha),
    });

    expect(report.scanned).toBe(54);
    const summary = summarizeUnmergedWorkspaceBuckets(report.classifications);
    expect(summary["no-branch"]).toBe(15);
    expect(summary["zero-ahead"]).toBe(18);
    expect(summary.outstanding).toBe(21);
    expect(outstandingUnmergedWorkspaces(report.classifications)).toHaveLength(21);
  });

  it("skips a candidate whose base branch cannot be resolved, rather than misclassifying it", async () => {
    const { projectId, statusId } = await seedProject(db);
    await seedWorkspace(db, { projectId, statusId, issueNumber: 700, branch: "feature/ak-700-badbase" });

    const checkAncestor = makeCheckAncestor({
      "feature/ak-700-badbase": { isAncestor: false, branchSha: null, reason: "base-not-found" },
    });

    const report = await classifyUnmergedWorkspaces(projectId, { database: db, checkAncestor });

    expect(report.classifications).toHaveLength(0);
    expect(report.skipped).toBe(1);
  });

  it("excludes direct and closed workspaces from the scan", async () => {
    const { projectId, statusId } = await seedProject(db);
    await seedWorkspace(db, { projectId, statusId, issueNumber: 800, branch: "feature/ak-800-direct", isDirect: true });
    await seedWorkspace(db, { projectId, statusId, issueNumber: 801, branch: "feature/ak-801-closed", wsStatus: "closed" });

    const report = await classifyUnmergedWorkspaces(projectId, { database: db, checkAncestor: makeCheckAncestor({}) });

    expect(report.scanned).toBe(0);
    expect(report.classifications).toHaveLength(0);
  });
});
