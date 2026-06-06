/**
 * Unit tests for scanDoneUnmergedWorkspaces (ticket #584 / #592).
 *
 * Acceptance criteria:
 * - Done issue with clean ahead-only branch → auto-merged, master advances, issue stays Done.
 * - Done issue with 0-commit branch → left untouched (log-only), no status change.
 * - Done issue with conflicting branch → left untouched (log-only), no status change.
 * - NEVER reopens an issue (no statusId change).
 *
 * Regression guard for the #581 incident: a buggy reconciler marked issues Done
 * while master never advanced — this scanner detects and recovers that state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, preferences, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { scanDoneUnmergedWorkspaces, startDoneUnmergedScanner } from "../startup/done-unmerged-invariant-scanner.js";
import type { BranchTipAncestryResult } from "@agentic-kanban/shared/lib/git-service";

type CheckAncestor = (repoPath: string, branch: string, baseBranch: string, worktreeDir?: string) => Promise<BranchTipAncestryResult>;
type CountCommits = (repoPath: string, baseSha: string, branchSha: string) => Promise<number>;
type DetectConflicts = (repoPath: string, featureBranch: string, baseBranch: string) => Promise<{ hasConflicts: boolean; conflictingFiles: string[] }>;
type CountBehind = (repoPath: string, featureBranch: string, baseBranch: string) => Promise<number>;
type MergeGitBranch = (repoPath: string, featureBranch: string, targetBranch: string) => Promise<string>;

function makeCheckAncestor(isAncestor: boolean, branchShaOverride?: string): CheckAncestor {
  return vi.fn(async (_repo, branch, base) => {
    const branchSha = branchShaOverride ?? `sha-${branch}`;
    if (isAncestor) {
      return { isAncestor: true as const, branchSha, baseSha: `sha-${base}` };
    }
    return { isAncestor: false as const, branchSha, baseSha: `sha-${base}` };
  });
}

function makeCountCommits(count: number): CountCommits {
  return vi.fn(async () => count);
}

function makeDetectConflicts(hasConflicts: boolean): DetectConflicts {
  return vi.fn(async () => ({ hasConflicts, conflictingFiles: hasConflicts ? ["README.md"] : [] }));
}

function makeCountBehind(behind: number): CountBehind {
  return vi.fn(async () => behind);
}

function makeMergeGitBranch(throws?: Error): MergeGitBranch {
  if (throws) return vi.fn(async () => { throw throws; });
  return vi.fn(async () => "Merge branch 'feature/test'");
}

async function seedWorkspace(
  db: ReturnType<typeof createTestDb>["db"],
  opts: {
    issueStatusName?: string;
    wsStatus?: string;
    isDirect?: boolean;
    issueNumber?: number;
    mergedAt?: string | null;
  } = {},
) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const doneStatusId = randomUUID();
  const inReviewStatusId = randomUUID();
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
    {
      id: inReviewStatusId,
      projectId,
      name: "In Review",
      sortOrder: 2,
      isDefault: false,
      createdAt: now,
    },
    {
      id: doneStatusId,
      projectId,
      name: opts.issueStatusName ?? "Done",
      sortOrder: 3,
      isDefault: false,
      createdAt: now,
    },
  ]);
  await db.insert(issues).values({
    id: issueId,
    issueNumber: opts.issueNumber ?? 584,
    title: "Done-but-unmerged issue",
    priority: "medium",
    sortOrder: 0,
    statusId: doneStatusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  const mergedAt = opts.mergedAt !== undefined ? opts.mergedAt : null;
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/ak-584-test",
    workingDir: "/repo/.worktrees/ws",
    baseBranch: "master",
    isDirect: opts.isDirect ?? false,
    status: opts.wsStatus ?? "closed",
    readyForMerge: false,
    mergedAt,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });

  return { projectId, issueId, workspaceId, doneStatusId, inReviewStatusId };
}

describe("scanDoneUnmergedWorkspaces", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  // --- Core detection ---

  it("regression #584/#581: detects Done issue whose branch is NOT reachable from base and has >=1 unique commit", async () => {
    const { issueId, workspaceId } = await seedWorkspace(db);
    const checkAncestor = makeCheckAncestor(false);
    const countCommits = makeCountCommits(3);

    const result = await scanDoneUnmergedWorkspaces({
      database: db, checkAncestor, countCommits,
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(0),
      mergeGitBranch: makeMergeGitBranch(),
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].uniqueCommitCount).toBe(3);
    expect(result.findings[0].workspaceId).toBe(workspaceId);
    expect(result.findings[0].issueId).toBe(issueId);
  });

  it("is a no-op when the branch IS already reachable from base (work landed — not a violation)", async () => {
    const { issueId } = await seedWorkspace(db);
    const checkAncestor = makeCheckAncestor(true);

    const result = await scanDoneUnmergedWorkspaces({
      database: db, checkAncestor, countCommits: makeCountCommits(2),
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(0),
      mergeGitBranch: makeMergeGitBranch(),
    });

    expect(result.findings).toHaveLength(0);
    expect(result.autoMerged).toBe(0);

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");
  });

  // --- Auto-merge: clean ahead-only branch ---

  it("#592: auto-merges Done issue with clean ahead-only branch; issue stays Done", async () => {
    const { issueId, workspaceId } = await seedWorkspace(db);
    const checkAncestor = makeCheckAncestor(false);
    const countCommits = makeCountCommits(1);
    const mergeGitBranch = makeMergeGitBranch();

    const result = await scanDoneUnmergedWorkspaces({
      database: db, checkAncestor, countCommits,
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(0),
      mergeGitBranch,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.autoMerged).toBe(1);
    expect(mergeGitBranch).toHaveBeenCalledWith("/repo", "feature/ak-584-test", "master");

    // Workspace is stamped mergedAt (closed)
    const [ws] = await db.select({ mergedAt: workspaces.mergedAt, status: workspaces.status })
      .from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.mergedAt).not.toBeNull();
    expect(ws.status).toBe("closed");

    // Issue stays Done — NEVER reopened
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");
  });

  it("#592: NEVER reopens issue — 0-commit branch is log-only, no status change", async () => {
    const { issueId, workspaceId } = await seedWorkspace(db);
    const checkAncestor = makeCheckAncestor(false);
    const mergeGitBranch = makeMergeGitBranch();

    const result = await scanDoneUnmergedWorkspaces({
      database: db, checkAncestor, countCommits: makeCountCommits(0),
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(0),
      mergeGitBranch,
    });

    expect(result.findings).toHaveLength(0);
    expect(result.autoMerged).toBe(0);
    expect(mergeGitBranch).not.toHaveBeenCalled();

    // Issue stays Done
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");

    // Workspace not touched
    const [ws] = await db.select({ mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.mergedAt).toBeNull();
  });

  it("#592: conflicting branch is log-only, never auto-merged, no status change", async () => {
    const { issueId, workspaceId } = await seedWorkspace(db);
    const checkAncestor = makeCheckAncestor(false);
    const mergeGitBranch = makeMergeGitBranch();

    const result = await scanDoneUnmergedWorkspaces({
      database: db, checkAncestor, countCommits: makeCountCommits(2),
      detectConflicts: makeDetectConflicts(true),
      countBehind: makeCountBehind(1),
      mergeGitBranch,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.autoMerged).toBe(0);
    expect(mergeGitBranch).not.toHaveBeenCalled();

    // Issue stays Done — no reopen
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");

    // Workspace not touched
    const [ws] = await db.select({ mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.mergedAt).toBeNull();
  });

  it("#592: too-far-behind branch (>20) is log-only, never auto-merged", async () => {
    const { workspaceId } = await seedWorkspace(db);
    const mergeGitBranch = makeMergeGitBranch();

    const result = await scanDoneUnmergedWorkspaces({
      database: db,
      checkAncestor: makeCheckAncestor(false),
      countCommits: makeCountCommits(3),
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(21),
      mergeGitBranch,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.autoMerged).toBe(0);
    expect(mergeGitBranch).not.toHaveBeenCalled();

    const [ws] = await db.select({ mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.mergedAt).toBeNull();
  });

  it("#592: rate-limit cap — auto-merges at most 3 per cycle", async () => {
    // Seed 4 workspaces that all qualify for auto-merge
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const doneStatusId = randomUUID();
    await db.insert(projects).values({ id: projectId, name: "P", repoPath: "/repo", repoName: "repo", defaultBranch: "master", createdAt: now, updatedAt: now });
    await db.insert(projectStatuses).values([
      { id: doneStatusId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
    ]);

    const wsIds: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const issueId = randomUUID();
      const wsId = randomUUID();
      await db.insert(issues).values({ id: issueId, issueNumber: i, title: `Issue ${i}`, priority: "medium", sortOrder: i, statusId: doneStatusId, projectId, createdAt: now, updatedAt: now });
      await db.insert(workspaces).values({ id: wsId, issueId, branch: `feature/ws${i}`, workingDir: `/repo/.w/${i}`, baseBranch: "master", isDirect: false, status: "closed", readyForMerge: false, mergedAt: null, provider: "claude", createdAt: now, updatedAt: now });
      wsIds.push(wsId);
    }

    const mergeGitBranch = makeMergeGitBranch();

    const result = await scanDoneUnmergedWorkspaces({
      database: db,
      checkAncestor: makeCheckAncestor(false),
      countCommits: makeCountCommits(1),
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(0),
      mergeGitBranch,
    });

    expect(result.findings).toHaveLength(4);
    expect(result.autoMerged).toBe(3); // capped at 3
    expect(mergeGitBranch).toHaveBeenCalledTimes(3);
  });

  it("skips direct workspaces (no worktree branch to check)", async () => {
    const { issueId } = await seedWorkspace(db, { isDirect: true });
    const checkAncestor = makeCheckAncestor(false);

    const result = await scanDoneUnmergedWorkspaces({
      database: db, checkAncestor, countCommits: makeCountCommits(3),
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(0),
      mergeGitBranch: makeMergeGitBranch(),
    });

    expect(checkAncestor).not.toHaveBeenCalled();
    expect(result.findings).toHaveLength(0);

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");
  });

  it("scans 'AI Reviewed' issues too (another terminal Done-equivalent status)", async () => {
    const { issueId } = await seedWorkspace(db, { issueStatusName: "AI Reviewed" });
    const checkAncestor = makeCheckAncestor(false);
    const countCommits = makeCountCommits(1);

    const result = await scanDoneUnmergedWorkspaces({
      database: db, checkAncestor, countCommits,
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(0),
      mergeGitBranch: makeMergeGitBranch(),
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].statusName).toBe("AI Reviewed");
  });

  it("is a no-op for non-Done issues (In Review, In Progress, Backlog)", async () => {
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const inReviewStatusId = randomUUID();
    const issueId = randomUUID();
    const wsId = randomUUID();

    await db.insert(projects).values({ id: projectId, name: "P", repoPath: "/repo", repoName: "repo", defaultBranch: "master", createdAt: now, updatedAt: now });
    await db.insert(projectStatuses).values([
      { id: inReviewStatusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now },
    ]);
    await db.insert(issues).values({ id: issueId, issueNumber: 1, title: "Issue", priority: "medium", sortOrder: 0, statusId: inReviewStatusId, projectId, createdAt: now, updatedAt: now });
    await db.insert(workspaces).values({ id: wsId, issueId, branch: "feature/ws", workingDir: "/repo/.w", baseBranch: "master", isDirect: false, status: "idle", readyForMerge: false, mergedAt: null, provider: "claude", createdAt: now, updatedAt: now });

    const checkAncestor = makeCheckAncestor(false);
    const result = await scanDoneUnmergedWorkspaces({
      database: db, checkAncestor, countCommits: makeCountCommits(5),
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(0),
      mergeGitBranch: makeMergeGitBranch(),
    });

    expect(checkAncestor).not.toHaveBeenCalled();
    expect(result.findings).toHaveLength(0);
  });

  it("continues processing other workspaces when git check throws for one", async () => {
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const doneStatusId = randomUUID();
    const inReviewStatusId = randomUUID();
    const issueId1 = randomUUID();
    const issueId2 = randomUUID();
    const wsId1 = randomUUID();
    const wsId2 = randomUUID();

    await db.insert(projects).values({ id: projectId, name: "P", repoPath: "/repo", repoName: "repo", defaultBranch: "master", createdAt: now, updatedAt: now });
    await db.insert(projectStatuses).values([
      { id: inReviewStatusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now },
      { id: doneStatusId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
    ]);
    await db.insert(issues).values([
      { id: issueId1, issueNumber: 1, title: "Issue 1", priority: "medium", sortOrder: 0, statusId: doneStatusId, projectId, createdAt: now, updatedAt: now },
      { id: issueId2, issueNumber: 2, title: "Issue 2", priority: "medium", sortOrder: 1, statusId: doneStatusId, projectId, createdAt: now, updatedAt: now },
    ]);
    await db.insert(workspaces).values([
      { id: wsId1, issueId: issueId1, branch: "feature/ws1", workingDir: "/repo/.w/1", baseBranch: "master", isDirect: false, status: "closed", readyForMerge: false, mergedAt: null, provider: "claude", createdAt: now, updatedAt: now },
      { id: wsId2, issueId: issueId2, branch: "feature/ws2", workingDir: "/repo/.w/2", baseBranch: "master", isDirect: false, status: "closed", readyForMerge: false, mergedAt: null, provider: "claude", createdAt: now, updatedAt: now },
    ]);

    let callNum = 0;
    const checkAncestor: CheckAncestor = vi.fn(async (_repo, branch, base) => {
      callNum++;
      if (callNum === 1) throw new Error("git exploded");
      return { isAncestor: false as const, branchSha: `sha-${branch}`, baseSha: `sha-${base}` };
    });

    const result = await scanDoneUnmergedWorkspaces({
      database: db, checkAncestor, countCommits: makeCountCommits(1),
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(0),
      mergeGitBranch: makeMergeGitBranch(),
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].issueId).toBe(issueId2);
  });

  it("is disabled when deps.enabled=false — no git calls, no findings", async () => {
    await seedWorkspace(db);
    const checkAncestor = makeCheckAncestor(false);

    const result = await scanDoneUnmergedWorkspaces({
      database: db, checkAncestor, countCommits: makeCountCommits(5), enabled: false,
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(0),
      mergeGitBranch: makeMergeGitBranch(),
    });

    expect(checkAncestor).not.toHaveBeenCalled();
    expect(result.findings).toHaveLength(0);
    expect(result.autoMerged).toBe(0);
  });

  it("is disabled when the DB preference is set to 'false'", async () => {
    const { issueId } = await seedWorkspace(db);
    const checkAncestor = makeCheckAncestor(false);
    const now = new Date().toISOString();

    await db.insert(preferences).values({ key: "done_unmerged_scanner_enabled", value: "false", updatedAt: now })
      .onConflictDoUpdate({ target: preferences.key, set: { value: "false", updatedAt: now } });

    const result = await scanDoneUnmergedWorkspaces({
      database: db, checkAncestor, countCommits: makeCountCommits(5),
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(0),
      mergeGitBranch: makeMergeGitBranch(),
    });

    expect(checkAncestor).not.toHaveBeenCalled();
    expect(result.findings).toHaveLength(0);

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");
  });

  it("#589: Done-but-unmerged issue seeded mid-run is detected within the next interval tick", async () => {
    vi.useFakeTimers();
    const { issueId, workspaceId } = await seedWorkspace(db);
    const checkAncestor = makeCheckAncestor(false);
    const countCommits = makeCountCommits(2);

    const { timer, interval } = startDoneUnmergedScanner(
      {
        database: db, checkAncestor, countCommits,
        detectConflicts: makeDetectConflicts(false),
        countBehind: makeCountBehind(0),
        mergeGitBranch: makeMergeGitBranch(),
      },
      /* intervalMs */ 1_000,
    );

    // Advance past the initial 40 s delay so the first scheduled tick fires.
    await vi.advanceTimersByTimeAsync(41_000);

    // checkAncestor was called — the scan ran and evaluated the branch.
    expect(checkAncestor).toHaveBeenCalled();

    // The issue was auto-merged (clean, ahead=2, behind=0)
    const [ws] = await db.select({ mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.mergedAt).not.toBeNull();

    // Issue stays Done
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");

    clearTimeout(timer);
    clearInterval(interval);
    vi.useRealTimers();
  });

  it("#590 guard 1: skips issue that has ANY workspace with mergedAt set (false-positive fix)", async () => {
    // Seed issue with two workspaces: ws-A (mergedAt set = genuinely merged), ws-B (mergedAt null = stale)
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const doneStatusId = randomUUID();
    const inReviewStatusId = randomUUID();
    const issueId = randomUUID();
    const wsAId = randomUUID();
    const wsBId = randomUUID();

    await db.insert(projects).values({ id: projectId, name: "P", repoPath: "/repo", repoName: "repo", defaultBranch: "master", createdAt: now, updatedAt: now });
    await db.insert(projectStatuses).values([
      { id: inReviewStatusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now },
      { id: doneStatusId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
    ]);
    await db.insert(issues).values({ id: issueId, issueNumber: 503, title: "Issue #503", priority: "medium", sortOrder: 0, statusId: doneStatusId, projectId, createdAt: now, updatedAt: now });
    // ws-A: merged workspace (the real merge) — mergedAt is set
    await db.insert(workspaces).values({ id: wsAId, issueId, branch: "feature/ak-503-done", workingDir: "/repo/.w/a", baseBranch: "master", isDirect: false, status: "closed", readyForMerge: false, mergedAt: now, provider: "claude", createdAt: now, updatedAt: now });
    // ws-B: stale workspace with null mergedAt — this was the false-positive trigger
    await db.insert(workspaces).values({ id: wsBId, issueId, branch: "feature/ak-503-stale", workingDir: "/repo/.w/b", baseBranch: "master", isDirect: false, status: "closed", readyForMerge: false, mergedAt: null, provider: "claude", createdAt: now, updatedAt: now });

    const checkAncestor = makeCheckAncestor(false);
    const countCommits = makeCountCommits(2);

    const result = await scanDoneUnmergedWorkspaces({ database: db, checkAncestor, countCommits, reopenToInReview: true });

    // The issue must NOT be flagged or reopened — it has a genuinely merged workspace
    expect(result.findings).toHaveLength(0);
    expect(result.reopened).toBe(0);
    // The git check should be skipped entirely for this issue
    expect(checkAncestor).not.toHaveBeenCalled();

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");
  });

  it("#615 guard 1: stale n-commit branch does NOT reopen already merged Done ticket", async () => {
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const doneStatusId = randomUUID();
    const issueId = randomUUID();
    const wsMergedId = randomUUID();
    const wsStaleId = randomUUID();

    await db.insert(projects).values({
      id: projectId,
      name: "P",
      repoPath: "/repo",
      repoName: "repo",
      defaultBranch: "master",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(projectStatuses).values([
      { id: doneStatusId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
    ]);
    await db.insert(issues).values({
      id: issueId,
      issueNumber: 615,
      title: "AK-615 stale issue branch",
      priority: "medium",
      sortOrder: 0,
      statusId: doneStatusId,
      projectId,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(workspaces).values({
      id: wsMergedId,
      issueId,
      branch: "feature/ak-615-done",
      workingDir: "/repo/.w/done",
      baseBranch: "master",
      isDirect: false,
      status: "closed",
      readyForMerge: false,
      mergedAt: now,
      provider: "claude",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(workspaces).values({
      id: wsStaleId,
      issueId,
      branch: "feature/ak-615-stale",
      workingDir: "/repo/.w/stale",
      baseBranch: "master",
      isDirect: false,
      status: "closed",
      readyForMerge: false,
      mergedAt: null,
      provider: "claude",
      createdAt: now,
      updatedAt: now,
    });

    const checkAncestor = makeCheckAncestor(false);
    const countCommits = makeCountCommits(3);
    const countBehind = makeCountBehind(0);
    const mergeGitBranch = makeMergeGitBranch();

    const result = await scanDoneUnmergedWorkspaces({
      database: db,
      checkAncestor,
      countCommits,
      countBehind,
      detectConflicts: makeDetectConflicts(false),
      mergeGitBranch,
      reopenToInReview: true,
      maxCommitsBehindBase: 20,
    });

    expect(result.findings).toHaveLength(0);
    expect(result.autoMerged).toBe(0);
    expect(result.reopened).toBe(0);
    expect(checkAncestor).not.toHaveBeenCalled();
    expect(countCommits).not.toHaveBeenCalled();
    expect(mergeGitBranch).not.toHaveBeenCalled();

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");
  });

  it("#615 guard 2: n-commit branch reachable from base does not reopen done issue", async () => {
    const { issueId, workspaceId } = await seedWorkspace(db, { issueStatusName: "Done" });
    const checkAncestor = makeCheckAncestor(true);
    const countCommits = makeCountCommits(4);

    const result = await scanDoneUnmergedWorkspaces({
      database: db,
      checkAncestor,
      countCommits,
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(0),
      mergeGitBranch: makeMergeGitBranch(),
    });

    expect(result.findings).toHaveLength(0);
    expect(result.autoMerged).toBe(0);
    expect(checkAncestor).toHaveBeenCalledTimes(1);
    expect(countCommits).not.toHaveBeenCalled();

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");
    const [ws] = await db.select({ mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.mergedAt).toBeNull();
  });

  it("#615 guard 3: zero-commit branch is log-only and does not reopen merged Done ticket", async () => {
    const { issueId, workspaceId } = await seedWorkspace(db, { issueStatusName: "Done" });
    const checkAncestor = makeCheckAncestor(false);
    const countCommits = makeCountCommits(0);
    const mergeGitBranch = makeMergeGitBranch();

    const result = await scanDoneUnmergedWorkspaces({
      database: db,
      checkAncestor,
      countCommits,
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(0),
      mergeGitBranch,
    });

    expect(result.findings).toHaveLength(0);
    expect(result.autoMerged).toBe(0);
    expect(mergeGitBranch).not.toHaveBeenCalled();

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");

    const [ws] = await db.select({ mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.mergedAt).toBeNull();
  });

  it("#632 guard: merged Done issue is not flagged when stale worktree was cleaned after merge", async () => {
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const doneStatusId = randomUUID();
    const issueId = randomUUID();
    const wsMergedId = randomUUID();
    const wsStaleId = randomUUID();

    await db.insert(projects).values({
      id: projectId,
      name: "P",
      repoPath: "/repo",
      repoName: "repo",
      defaultBranch: "master",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(projectStatuses).values([
      { id: doneStatusId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
    ]);
    await db.insert(issues).values({
      id: issueId,
      issueNumber: 632,
      title: "AK-632 stale cleanup false-positive",
      priority: "medium",
      sortOrder: 0,
      statusId: doneStatusId,
      projectId,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(workspaces).values({
      id: wsMergedId,
      issueId,
      branch: "feature/ak-632-done",
      workingDir: "/repo/.w/done",
      baseBranch: "master",
      isDirect: false,
      status: "closed",
      readyForMerge: false,
      mergedAt: now,
      provider: "claude",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(workspaces).values({
      id: wsStaleId,
      issueId,
      branch: "feature/ak-632-stale",
      workingDir: null,
      baseBranch: "master",
      isDirect: false,
      status: "closed",
      readyForMerge: false,
      mergedAt: null,
      provider: "claude",
      createdAt: now,
      updatedAt: now,
    });

    const checkAncestor = makeCheckAncestor(false);
    const countCommits = makeCountCommits(2);

    const result = await scanDoneUnmergedWorkspaces({
      database: db,
      checkAncestor,
      countCommits,
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(0),
      mergeGitBranch: makeMergeGitBranch(),
    });

    expect(result.findings).toHaveLength(0);
    expect(result.reopened).toBe(0);
    expect(result.autoMerged).toBe(0);
    expect(checkAncestor).not.toHaveBeenCalled();
    expect(countCommits).not.toHaveBeenCalled();

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");
  });

  it("#632 guard: already-merged cleanup-cleaned Done workspace is not a false-positive", async () => {
    const { issueId, workspaceId } = await seedWorkspace(db, { issueStatusName: "Done" });
    await db.update(workspaces).set({ workingDir: null }).where(eq(workspaces.id, workspaceId));
    const checkAncestor = makeCheckAncestor(true);
    const countCommits = makeCountCommits(4);

    const result = await scanDoneUnmergedWorkspaces({
      database: db,
      checkAncestor,
      countCommits,
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(0),
      mergeGitBranch: makeMergeGitBranch(),
    });

    expect(result.findings).toHaveLength(0);
    expect(result.autoMerged).toBe(0);
    expect(checkAncestor).toHaveBeenCalledTimes(1);
    expect(countCommits).not.toHaveBeenCalled();

    // Existing Done ticket remains done (log-only check for already-merged branch).
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");

    const [ws] = await db.select({ mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.mergedAt).toBeNull();
  });

  it("#590 guard 2: skips workspace whose branch is more than maxCommitsBehindBase commits behind base (stale abandoned branch)", async () => {
    const { issueId } = await seedWorkspace(db);
    const checkAncestor = makeCheckAncestor(false);
    // countCommits is called twice: first for commitsBehind (args: branchSha, baseSha → 25 behind),
    // then for uniqueCommits ahead (would be 3 if not skipped).
    // We inject a counter that returns 25 on the first call and 3 on any subsequent call.
    let callCount = 0;
    const countCommits: CountCommits = vi.fn(async () => {
      callCount++;
      return callCount === 1 ? 25 : 3;
    });

    const result = await scanDoneUnmergedWorkspaces({
      database: db,
      checkAncestor,
      countCommits,
      reopenToInReview: true,
      maxCommitsBehindBase: 20,
    });

    expect(result.findings).toHaveLength(0);
    expect(result.reopened).toBe(0);
    // Only the behind-count call was made; uniqueCommits call must be skipped
    expect(callCount).toBe(1);

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");
  });

  it("#590 guard 2: does NOT skip workspace that is within the staleness threshold (recoverable loss)", async () => {
    const { issueId, workspaceId } = await seedWorkspace(db);
    const checkAncestor = makeCheckAncestor(false);
    // First call = commitsBehind (5, within threshold 20); second call = uniqueCommits ahead (2)
    let callCount = 0;
    const countCommits: CountCommits = vi.fn(async () => {
      callCount++;
      return callCount === 1 ? 5 : 2;
    });

    const result = await scanDoneUnmergedWorkspaces({
      database: db,
      checkAncestor,
      countCommits,
      reopenToInReview: false,
      maxCommitsBehindBase: 20,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].workspaceId).toBe(workspaceId);
    expect(result.findings[0].issueId).toBe(issueId);
  });

  it("is idempotent — after auto-merge the workspace has mergedAt and is no longer scanned", async () => {
    const { workspaceId } = await seedWorkspace(db);

    const first = await scanDoneUnmergedWorkspaces({
      database: db,
      checkAncestor: makeCheckAncestor(false),
      countCommits: makeCountCommits(2),
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(0),
      mergeGitBranch: makeMergeGitBranch(),
    });
    expect(first.autoMerged).toBe(1);

    // Workspace now has mergedAt — second scan excludes it (WHERE mergedAt IS NULL)
    const secondMerge = makeMergeGitBranch();
    const second = await scanDoneUnmergedWorkspaces({
      database: db,
      checkAncestor: makeCheckAncestor(false),
      countCommits: makeCountCommits(2),
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(0),
      mergeGitBranch: secondMerge,
    });

    expect(second.findings).toHaveLength(0);
    expect(second.autoMerged).toBe(0);
    expect(secondMerge).not.toHaveBeenCalled();

    // Workspace mergedAt still set
    const [ws] = await db.select({ mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.mergedAt).not.toBeNull();
  });

  it("#592: auto-merge failure is non-fatal — workspace not stamped, scan continues", async () => {
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const doneStatusId = randomUUID();
    await db.insert(projects).values({ id: projectId, name: "P", repoPath: "/repo", repoName: "repo", defaultBranch: "master", createdAt: now, updatedAt: now });
    await db.insert(projectStatuses).values([
      { id: doneStatusId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
    ]);

    const issueId1 = randomUUID(); const wsId1 = randomUUID();
    const issueId2 = randomUUID(); const wsId2 = randomUUID();
    await db.insert(issues).values([
      { id: issueId1, issueNumber: 1, title: "Issue 1", priority: "medium", sortOrder: 0, statusId: doneStatusId, projectId, createdAt: now, updatedAt: now },
      { id: issueId2, issueNumber: 2, title: "Issue 2", priority: "medium", sortOrder: 1, statusId: doneStatusId, projectId, createdAt: now, updatedAt: now },
    ]);
    await db.insert(workspaces).values([
      { id: wsId1, issueId: issueId1, branch: "feature/ws1", workingDir: "/repo/.w/1", baseBranch: "master", isDirect: false, status: "closed", readyForMerge: false, mergedAt: null, provider: "claude", createdAt: now, updatedAt: now },
      { id: wsId2, issueId: issueId2, branch: "feature/ws2", workingDir: "/repo/.w/2", baseBranch: "master", isDirect: false, status: "closed", readyForMerge: false, mergedAt: null, provider: "claude", createdAt: now, updatedAt: now },
    ]);

    let callCount = 0;
    const mergeGitBranch: MergeGitBranch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error("git merge failed");
      return "Merge branch 'feature/ws2'";
    });

    const result = await scanDoneUnmergedWorkspaces({
      database: db,
      checkAncestor: makeCheckAncestor(false),
      countCommits: makeCountCommits(1),
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(0),
      mergeGitBranch,
    });

    expect(result.findings).toHaveLength(2);
    // First failed, second succeeded
    expect(result.autoMerged).toBe(1);

    // First workspace: not stamped (merge failed)
    const [ws1] = await db.select({ mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, wsId1));
    expect(ws1.mergedAt).toBeNull();

    // Second workspace: stamped
    const [ws2] = await db.select({ mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, wsId2));
    expect(ws2.mergedAt).not.toBeNull();
  });

  // --- Integration: 0-commit, n-commit, stale branch reachability (#630) ---

  it("#630 integration: 0-commit closed/behind branch — no finding, no status change", async () => {
    // Scenario: workspace is closed, branch is behind base, but has 0 unique commits ahead.
    // The scanner must not flag this as a violation — 0-commit branches have no real work.
    const { issueId, workspaceId } = await seedWorkspace(db, { wsStatus: "closed" });
    const checkAncestor = makeCheckAncestor(false);
    // commitsBehind=5 (within threshold), uniqueCommits=0 (no work ahead)
    let callCount = 0;
    const countCommits: CountCommits = vi.fn(async () => {
      callCount++;
      return callCount === 1 ? 5 : 0; // first=behind, second=ahead
    });
    const mergeGitBranch = makeMergeGitBranch();

    const result = await scanDoneUnmergedWorkspaces({
      database: db, checkAncestor, countCommits,
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(5),
      mergeGitBranch,
      maxCommitsBehindBase: 20,
    });

    expect(result.findings).toHaveLength(0);
    expect(result.autoMerged).toBe(0);
    expect(mergeGitBranch).not.toHaveBeenCalled();

    // Issue stays Done
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");

    // Workspace not touched
    const [ws] = await db.select({ mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.mergedAt).toBeNull();
  });

  it("#630 integration: n-commit closed/behind branch within threshold — flagged and auto-merged", async () => {
    // Scenario: workspace is closed, branch has N commits ahead and M commits behind base
    // (M within the staleness threshold). No conflicts. Scanner flags it and auto-merges.
    const { issueId, workspaceId } = await seedWorkspace(db, { wsStatus: "closed" });
    const checkAncestor = makeCheckAncestor(false);
    // commitsBehind=3 (within threshold 20), uniqueCommits=4 (real work ahead)
    let callCount = 0;
    const countCommits: CountCommits = vi.fn(async () => {
      callCount++;
      return callCount === 1 ? 3 : 4; // first=behind, second=ahead
    });
    const mergeGitBranch = makeMergeGitBranch();

    const result = await scanDoneUnmergedWorkspaces({
      database: db, checkAncestor, countCommits,
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(3),
      mergeGitBranch,
      maxCommitsBehindBase: 20,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].uniqueCommitCount).toBe(4);
    expect(result.autoMerged).toBe(1);
    expect(mergeGitBranch).toHaveBeenCalledOnce();

    // Issue stays Done — scanner never reopens
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");

    // Workspace stamped with mergedAt
    const [ws] = await db.select({ mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.mergedAt).not.toBeNull();
  });

  it("#630 integration: n-commit branch with stale reachability (ancestor=true) — no finding", async () => {
    // Scenario: Done issue, closed workspace, branch has commits but branch tip IS already
    // reachable from base (ancestor=true). This is the normal merged-work case.
    // The scanner must stop at the ancestry check and produce 0 findings.
    const { issueId, workspaceId } = await seedWorkspace(db, { wsStatus: "closed" });
    const checkAncestor = makeCheckAncestor(true);
    const countCommits = makeCountCommits(5); // would be non-zero but should never be called
    const mergeGitBranch = makeMergeGitBranch();

    const result = await scanDoneUnmergedWorkspaces({
      database: db, checkAncestor, countCommits,
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(0),
      mergeGitBranch,
    });

    expect(result.findings).toHaveLength(0);
    expect(result.autoMerged).toBe(0);
    // Ancestry check fired, but commit-counting was short-circuited
    expect(checkAncestor).toHaveBeenCalledOnce();
    expect(countCommits).not.toHaveBeenCalled();
    expect(mergeGitBranch).not.toHaveBeenCalled();

    // Issue stays Done
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");

    // Workspace untouched
    const [ws] = await db.select({ mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.mergedAt).toBeNull();
  });

  // --- Regression: branch cleanup scenarios (#639) ---
  // When stale worktree branches are explicitly deleted (cleaned up) after workspace
  // closure, the scanner must not produce false-positive findings or reopen valid Done
  // issues. These tests cover 0-commit, n-commit, and stale reachability with deleted branches.

  it("#639 regression: branch deleted after cleanup — checkAncestor returns no branchSha → no finding, issue stays Done", async () => {
    // Scenario: stale branch was cleaned up (deleted from git). checkAncestor returns
    // isAncestor=false but branchSha is empty (branch no longer exists in the repo).
    // The scanner must skip at the `if (!result.branchSha) continue` guard.
    const { issueId, workspaceId } = await seedWorkspace(db);
    const checkAncestor = vi.fn(async () => ({
      isAncestor: false as const,
      branchSha: "", // branch deleted — no SHA available
      baseSha: "sha-master",
    }));
    const countCommits = makeCountCommits(2);
    const mergeGitBranch = makeMergeGitBranch();

    const result = await scanDoneUnmergedWorkspaces({
      database: db, checkAncestor, countCommits,
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(0),
      mergeGitBranch,
    });

    expect(result.findings).toHaveLength(0);
    expect(result.autoMerged).toBe(0);
    expect(countCommits).not.toHaveBeenCalled();
    expect(mergeGitBranch).not.toHaveBeenCalled();

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");

    const [ws] = await db.select({ mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.mergedAt).toBeNull();
  });

  it("#639 regression: branch deleted after cleanup — checkAncestor throws (git error) → no finding, issue stays Done", async () => {
    // Scenario: branch was deleted. Git operations on the non-existent branch throw.
    // Scanner catches the error and skips → no false positive, no reopen.
    const { issueId, workspaceId } = await seedWorkspace(db);
    const checkAncestor = vi.fn(async () => {
      throw new Error("fatal: not a valid object name: feature/ak-584-test");
    });
    const countCommits = makeCountCommits(3);
    const mergeGitBranch = makeMergeGitBranch();

    const result = await scanDoneUnmergedWorkspaces({
      database: db, checkAncestor, countCommits,
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(0),
      mergeGitBranch,
    });

    expect(result.findings).toHaveLength(0);
    expect(result.autoMerged).toBe(0);
    expect(countCommits).not.toHaveBeenCalled();
    expect(mergeGitBranch).not.toHaveBeenCalled();

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");

    const [ws] = await db.select({ mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.mergedAt).toBeNull();
  });

  it("#639 regression: 0-commit branch + branch deleted — double-safe, no finding", async () => {
    // Scenario: workspace has 0 commits (false-positive class) AND the branch was cleaned up.
    // Both guards prevent any action — even if git calls somehow succeed, 0-commit blocks.
    const { issueId, workspaceId } = await seedWorkspace(db, { wsStatus: "closed" });
    const checkAncestor = makeCheckAncestor(false);
    const countCommits = makeCountCommits(0);
    const mergeGitBranch = makeMergeGitBranch();

    const result = await scanDoneUnmergedWorkspaces({
      database: db, checkAncestor, countCommits,
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(0),
      mergeGitBranch,
    });

    expect(result.findings).toHaveLength(0);
    expect(result.autoMerged).toBe(0);
    expect(mergeGitBranch).not.toHaveBeenCalled();

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");

    const [ws] = await db.select({ mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.mergedAt).toBeNull();
  });

  it("#639 regression: n-commit branch deleted mid-scan — merge fails, workspace not stamped, issue stays Done", async () => {
    // Scenario: branch exists during ancestry check (finding produced), but is deleted
    // before merge completes. mergeGitBranch throws. Scanner catches, logs warning,
    // does NOT stamp workspace. Issue stays Done regardless.
    const { issueId, workspaceId } = await seedWorkspace(db);
    const checkAncestor = makeCheckAncestor(false);
    let callCount = 0;
    const countCommits: CountCommits = vi.fn(async () => {
      callCount++;
      return callCount === 1 ? 2 : 3; // behind=2, ahead=3
    });
    const mergeGitBranch = vi.fn(async () => {
      throw new Error("fatal: The branch 'feature/ak-584-test' is not found.");
    });

    const result = await scanDoneUnmergedWorkspaces({
      database: db, checkAncestor, countCommits,
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(2),
      mergeGitBranch,
      maxCommitsBehindBase: 20,
    });

    // Finding was produced (branch existed at check time)
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].uniqueCommitCount).toBe(3);
    // Merge was attempted but failed
    expect(result.autoMerged).toBe(0);
    expect(mergeGitBranch).toHaveBeenCalledOnce();

    // Workspace NOT stamped (merge failed)
    const [ws] = await db.select({ mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.mergedAt).toBeNull();

    // Issue stays Done — scanner NEVER reopens
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");
  });

  it("#639 regression: mixed — one branch deleted, one 0-commit, one real finding — scanner handles all correctly", async () => {
    // Scenario: 3 Done issues with different branch states after cleanup:
    //  - Issue A: branch deleted (checkAncestor throws) → skip
    //  - Issue B: 0-commit branch → skip (no real work)
    //  - Issue C: real finding, 2 commits ahead, clean → flagged and auto-merged
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const doneStatusId = randomUUID();
    await db.insert(projects).values({ id: projectId, name: "P", repoPath: "/repo", repoName: "repo", defaultBranch: "master", createdAt: now, updatedAt: now });
    await db.insert(projectStatuses).values([
      { id: doneStatusId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
    ]);

    const issueA = randomUUID(); const wsA = randomUUID();
    const issueB = randomUUID(); const wsB = randomUUID();
    const issueC = randomUUID(); const wsC = randomUUID();

    await db.insert(issues).values([
      { id: issueA, issueNumber: 1, title: "A: deleted branch", priority: "medium", sortOrder: 0, statusId: doneStatusId, projectId, createdAt: now, updatedAt: now },
      { id: issueB, issueNumber: 2, title: "B: 0-commit branch", priority: "medium", sortOrder: 1, statusId: doneStatusId, projectId, createdAt: now, updatedAt: now },
      { id: issueC, issueNumber: 3, title: "C: real finding", priority: "medium", sortOrder: 2, statusId: doneStatusId, projectId, createdAt: now, updatedAt: now },
    ]);
    await db.insert(workspaces).values([
      { id: wsA, issueId: issueA, branch: "feature/a", workingDir: "/repo/.w/a", baseBranch: "master", isDirect: false, status: "closed", readyForMerge: false, mergedAt: null, provider: "claude", createdAt: now, updatedAt: now },
      { id: wsB, issueId: issueB, branch: "feature/b", workingDir: "/repo/.w/b", baseBranch: "master", isDirect: false, status: "closed", readyForMerge: false, mergedAt: null, provider: "claude", createdAt: now, updatedAt: now },
      { id: wsC, issueId: issueC, branch: "feature/c", workingDir: "/repo/.w/c", baseBranch: "master", isDirect: false, status: "closed", readyForMerge: false, mergedAt: null, provider: "claude", createdAt: now, updatedAt: now },
    ]);

    let callIdx = 0;
    const checkAncestor: CheckAncestor = vi.fn(async (_repo, branch) => {
      callIdx++;
      if (branch === "feature/a") throw new Error("branch deleted");
      if (branch === "feature/b") return { isAncestor: false as const, branchSha: `sha-b`, baseSha: "sha-master" };
      return { isAncestor: false as const, branchSha: `sha-c`, baseSha: "sha-master" };
    });

    const countCommits: CountCommits = vi.fn(async (_repo, from, to) => {
      // feature/b: behind=0, ahead=0 (0-commit)
      // feature/c: behind=1, ahead=2
      if (to === "sha-b") return 0; // behind for b
      if (from === "sha-master" && to === "sha-b") return 0;
      if (to === "sha-c") {
        // This is called as: countCommits(repoPath, branchSha, baseSha) for behind
        // then countCommits(repoPath, baseSha, branchSha) for ahead
        // But we need to distinguish. Let's use a counter.
        return 0; // Will be overridden by closure below
      }
      return 0;
    });

    // Use a more precise counter that tracks call order per branch
    let behindCallCount = 0;
    let aheadCallCount = 0;
    const preciseCountCommits: CountCommits = vi.fn(async (_repo, from, to) => {
      // Behind check: countCommits(repoPath, branchSha, baseSha)
      // Ahead check: countCommits(repoPath, baseSha, branchSha)
      if (to === "sha-master") {
        // This is the behind check (counting baseSha→branchSha means behind)
        // Actually, looking at the code: countCommits(repoPath, result.branchSha, result.baseSha) for behind
        // and countCommits(repoPath, result.baseSha, result.branchSha) for ahead
        behindCallCount++;
        if (from === "sha-b") return 0; // b: 0 behind
        if (from === "sha-c") return 1; // c: 1 behind
        return 0;
      } else {
        // Ahead check: countCommits(repoPath, result.baseSha, result.branchSha)
        aheadCallCount++;
        if (to === "sha-b") return 0; // b: 0 ahead (0-commit)
        if (to === "sha-c") return 2; // c: 2 ahead (real work)
        return 0;
      }
    });

    const mergeGitBranch = makeMergeGitBranch();

    const result = await scanDoneUnmergedWorkspaces({
      database: db,
      checkAncestor: checkAncestor,
      countCommits: preciseCountCommits,
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(1),
      mergeGitBranch,
      maxCommitsBehindBase: 20,
    });

    // Only issue C has a real finding (2 commits ahead)
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].issueId).toBe(issueC);
    expect(result.findings[0].uniqueCommitCount).toBe(2);
    expect(result.autoMerged).toBe(1);

    // All three issues stay Done
    for (const iid of [issueA, issueB, issueC]) {
      const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, iid));
      const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
      expect(status.name).toBe("Done");
    }

    // Only wsC was stamped
    const [wsARow] = await db.select({ mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, wsA));
    const [wsBRow] = await db.select({ mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, wsB));
    const [wsCRow] = await db.select({ mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, wsC));
    expect(wsARow.mergedAt).toBeNull();
    expect(wsBRow.mergedAt).toBeNull();
    expect(wsCRow.mergedAt).not.toBeNull();
  });

  it("#639 regression: stale far-behind branch deleted after cleanup — no finding, no reopen", async () => {
    // Scenario: ancient abandoned branch (way behind base) was cleaned up (deleted).
    // Even if git somehow resolves, the staleness guard (>maxCommitsBehindBase) skips it.
    const { issueId, workspaceId } = await seedWorkspace(db);
    const checkAncestor = makeCheckAncestor(false);
    let callCount = 0;
    const countCommits: CountCommits = vi.fn(async () => {
      callCount++;
      return callCount === 1 ? 658 : 3; // 658 behind (ancient #590 incident), 3 ahead
    });
    const mergeGitBranch = makeMergeGitBranch();

    const result = await scanDoneUnmergedWorkspaces({
      database: db, checkAncestor, countCommits,
      detectConflicts: makeDetectConflicts(false),
      countBehind: makeCountBehind(658),
      mergeGitBranch,
      maxCommitsBehindBase: 20,
    });

    expect(result.findings).toHaveLength(0);
    expect(result.autoMerged).toBe(0);
    // Only the behind-count call was made; uniqueCommits check skipped by staleness guard
    expect(callCount).toBe(1);
    expect(mergeGitBranch).not.toHaveBeenCalled();

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");

    const [ws] = await db.select({ mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.mergedAt).toBeNull();
  });

  it("#639 acceptance: comprehensive — no valid Done issue is reopened after branch cleanup scan", async () => {
    // Mega-scenario: multiple Done issues in various post-cleanup states.
    // Scanner runs once — NONE of them must be reopened.
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const doneStatusId = randomUUID();
    await db.insert(projects).values({ id: projectId, name: "P", repoPath: "/repo", repoName: "repo", defaultBranch: "master", createdAt: now, updatedAt: now });
    await db.insert(projectStatuses).values([
      { id: doneStatusId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
    ]);

    const ids: Array<{ issueId: string; wsId: string; scenario: string }> = [];
    const scenarios = [
      "branch-deleted-throw",
      "branch-deleted-no-sha",
      "0-commit",
      "ancestor-reachable",
      "stale-far-behind",
      "has-merged-workspace",
      "conflicting",
      "real-finding-clean",
    ];

    for (let i = 0; i < scenarios.length; i++) {
      const issueId = randomUUID();
      const wsId = randomUUID();
      // Scenario "has-merged-workspace" needs a second workspace with mergedAt set
      await db.insert(issues).values({
        id: issueId, issueNumber: i + 100, title: `Issue ${scenarios[i]}`,
        priority: "medium", sortOrder: i, statusId: doneStatusId, projectId, createdAt: now, updatedAt: now,
      });
      await db.insert(workspaces).values({
        id: wsId, issueId, branch: `feature/${scenarios[i]}`,
        workingDir: `/repo/.w/${i}`, baseBranch: "master",
        isDirect: false, status: "closed", readyForMerge: false, mergedAt: null,
        provider: "claude", createdAt: now, updatedAt: now,
      });
      ids.push({ issueId, wsId, scenario: scenarios[i] });
    }

    // Add a merged workspace for the "has-merged-workspace" scenario
    const mergedWsScenario = ids.find(s => s.scenario === "has-merged-workspace")!;
    await db.insert(workspaces).values({
      id: randomUUID(), issueId: mergedWsScenario.issueId,
      branch: "feature/merged-ws", workingDir: "/repo/.w/merged",
      baseBranch: "master", isDirect: false, status: "closed",
      readyForMerge: false, mergedAt: now, provider: "claude",
      createdAt: now, updatedAt: now,
    });

    let callIdx = 0;
    const checkAncestor: CheckAncestor = vi.fn(async (_repo, branch) => {
      if (branch === "feature/branch-deleted-throw") throw new Error("branch not found");
      if (branch === "feature/branch-deleted-no-sha") return { isAncestor: false as const, branchSha: "", baseSha: "sha-master" };
      if (branch === "feature/0-commit") return { isAncestor: false as const, branchSha: "sha-0c", baseSha: "sha-master" };
      if (branch === "feature/ancestor-reachable") return { isAncestor: true as const, branchSha: "sha-ar", baseSha: "sha-master" };
      if (branch === "feature/stale-far-behind") return { isAncestor: false as const, branchSha: "sha-sfb", baseSha: "sha-master" };
      if (branch === "feature/conflicting") return { isAncestor: false as const, branchSha: "sha-cf", baseSha: "sha-master" };
      if (branch === "feature/real-finding-clean") return { isAncestor: false as const, branchSha: "sha-rfc", baseSha: "sha-master" };
      return { isAncestor: true as const, branchSha: "sha-unknown", baseSha: "sha-master" };
    });

    const countCommits: CountCommits = vi.fn(async (_repo, from, to) => {
      // Behind check: countCommits(repoPath, branchSha, baseSha) — to is baseSha
      if (to === "sha-master") {
        if (from === "sha-0c") return 0;
        if (from === "sha-sfb") return 658; // ancient abandoned
        if (from === "sha-cf") return 1;
        if (from === "sha-rfc") return 2;
        return 0;
      }
      // Ahead check: countCommits(repoPath, baseSha, branchSha) — to is branchSha
      if (to === "sha-0c") return 0; // 0-commit
      if (to === "sha-cf") return 3; // conflicting but has commits
      if (to === "sha-rfc") return 4; // real work
      return 0;
    });

    const detectConflicts: DetectConflicts = vi.fn(async (_repo, branch) => {
      if (branch === "feature/conflicting") return { hasConflicts: true, conflictingFiles: ["src/main.ts"] };
      return { hasConflicts: false, conflictingFiles: [] };
    });

    const mergeGitBranch = makeMergeGitBranch();

    const result = await scanDoneUnmergedWorkspaces({
      database: db,
      checkAncestor,
      countCommits,
      detectConflicts,
      countBehind: makeCountBehind(2),
      mergeGitBranch,
      maxCommitsBehindBase: 20,
    });

    // Only "real-finding-clean" produces a finding and gets auto-merged
    expect(result.findings).toHaveLength(2); // conflicting is a finding (log-only) + real-finding-clean
    expect(result.autoMerged).toBe(1);

    // ACCEPTANCE: every issue stays Done — none were reopened
    for (const { issueId, scenario } of ids) {
      const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
      const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
      expect(status.name).toBe("Done");
    }
  });

  it("#630 integration: staleness boundary — exactly maxCommitsBehindBase commits behind is still processed and auto-merged", async () => {
    // Boundary condition: a branch exactly AT the staleness threshold (not over it) must
    // still be evaluated and, if clean, auto-merged.
    // The staleness check is `commitsBehind > maxCommitsBehindBase` (exclusive), so a branch
    // exactly N==threshold commits behind is NOT skipped — it remains a candidate.
    const { issueId, workspaceId } = await seedWorkspace(db, { wsStatus: "closed" });
    const checkAncestor = makeCheckAncestor(false);
    const THRESHOLD = 20;
    // commitsBehind = exactly THRESHOLD (at the limit but not over) → still processed
    // uniqueCommits = 2 (real work ahead)
    let callCount = 0;
    const countCommits: CountCommits = vi.fn(async () => {
      callCount++;
      return callCount === 1 ? THRESHOLD : 2; // first=behind (=threshold), second=ahead
    });
    const mergeGitBranch = makeMergeGitBranch();

    const result = await scanDoneUnmergedWorkspaces({
      database: db, checkAncestor, countCommits,
      detectConflicts: makeDetectConflicts(false),
      // Auto-merge "behind" check also uses > (exclusive): behind=0 → well within limit
      countBehind: makeCountBehind(0),
      mergeGitBranch,
      maxCommitsBehindBase: THRESHOLD,
    });

    // Branch at exactly the staleness threshold is NOT skipped — it's a finding and is auto-merged
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].uniqueCommitCount).toBe(2);
    expect(result.autoMerged).toBe(1);
    expect(mergeGitBranch).toHaveBeenCalledOnce();

    // Issue stays Done
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");

    // Workspace stamped with mergedAt
    const [ws] = await db.select({ mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.mergedAt).not.toBeNull();
  });
});
