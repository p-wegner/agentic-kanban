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
});
