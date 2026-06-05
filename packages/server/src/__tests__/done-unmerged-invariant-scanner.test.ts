/**
 * Unit tests for scanDoneUnmergedWorkspaces (ticket #584).
 *
 * Acceptance criteria: seed a workspace whose issue is Done but whose branch
 * is NOT reachable from base and has >=1 unique commit; run the scanner;
 * the issue is flagged and (when reopenToInReview=true) re-opened to In Review.
 *
 * Regression guard for the #581 incident: a buggy reconciler marked issues Done
 * while master never advanced — this scanner detects and recovers that state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, preferences, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { scanDoneUnmergedWorkspaces } from "../startup/done-unmerged-invariant-scanner.js";
import type { BranchTipAncestryResult } from "@agentic-kanban/shared/lib/git-service";

type CheckAncestor = (repoPath: string, branch: string, baseBranch: string, worktreeDir?: string) => Promise<BranchTipAncestryResult>;
type CountCommits = (repoPath: string, baseSha: string, branchSha: string) => Promise<number>;

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

async function seedWorkspace(
  db: ReturnType<typeof createTestDb>["db"],
  opts: {
    issueStatusName?: string;
    wsStatus?: string;
    isDirect?: boolean;
    issueNumber?: number;
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
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/ak-584-test",
    workingDir: "/repo/.worktrees/ws",
    baseBranch: "master",
    isDirect: opts.isDirect ?? false,
    status: opts.wsStatus ?? "closed",
    readyForMerge: false,
    mergedAt: null,
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

  it("regression #584/#581: detects Done issue whose branch is NOT reachable from base and has >=1 unique commit", async () => {
    const { issueId, workspaceId } = await seedWorkspace(db);
    const checkAncestor = makeCheckAncestor(false);
    const countCommits = makeCountCommits(3);

    const result = await scanDoneUnmergedWorkspaces({ database: db, checkAncestor, countCommits, reopenToInReview: false });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].uniqueCommitCount).toBe(3);
    expect(result.findings[0].workspaceId).toBe(workspaceId);
    expect(result.findings[0].issueId).toBe(issueId);
    expect(result.reopened).toBe(0);
  });

  it("re-opens issue to In Review and workspace to idle when reopenToInReview=true", async () => {
    const { issueId, workspaceId } = await seedWorkspace(db);
    const checkAncestor = makeCheckAncestor(false);
    const countCommits = makeCountCommits(2);

    const result = await scanDoneUnmergedWorkspaces({ database: db, checkAncestor, countCommits, reopenToInReview: true });

    expect(result.findings).toHaveLength(1);
    expect(result.reopened).toBe(1);

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("In Review");

    const [ws] = await db.select({ status: workspaces.status, readyForMerge: workspaces.readyForMerge }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("idle");
    expect(ws.readyForMerge).toBe(true);
  });

  it("is a no-op when the branch IS already reachable from base (work landed — not a violation)", async () => {
    const { issueId } = await seedWorkspace(db);
    const checkAncestor = makeCheckAncestor(true);
    const countCommits = makeCountCommits(2);

    const result = await scanDoneUnmergedWorkspaces({ database: db, checkAncestor, countCommits, reopenToInReview: true });

    expect(result.findings).toHaveLength(0);
    expect(result.reopened).toBe(0);

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");
  });

  it("is a no-op when the branch has 0 unique commits (no real work to lose)", async () => {
    const { issueId } = await seedWorkspace(db);
    const checkAncestor = makeCheckAncestor(false);
    const countCommits = makeCountCommits(0);

    const result = await scanDoneUnmergedWorkspaces({ database: db, checkAncestor, countCommits, reopenToInReview: true });

    expect(result.findings).toHaveLength(0);
    expect(result.reopened).toBe(0);

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");
  });

  it("skips direct workspaces (no worktree branch to check)", async () => {
    const { issueId } = await seedWorkspace(db, { isDirect: true });
    const checkAncestor = makeCheckAncestor(false);

    const result = await scanDoneUnmergedWorkspaces({ database: db, checkAncestor, countCommits: makeCountCommits(3), reopenToInReview: false });

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

    const result = await scanDoneUnmergedWorkspaces({ database: db, checkAncestor, countCommits, reopenToInReview: false });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].statusName).toBe("AI Reviewed");
  });

  it("is a no-op for non-Done issues (In Review, In Progress, Backlog)", async () => {
    // Seed issue in In Review — should not be scanned
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
    const result = await scanDoneUnmergedWorkspaces({ database: db, checkAncestor, countCommits: makeCountCommits(5), reopenToInReview: true });

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
    const countCommits = makeCountCommits(1);

    const result = await scanDoneUnmergedWorkspaces({ database: db, checkAncestor, countCommits, reopenToInReview: false });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].issueId).toBe(issueId2);
  });

  it("is disabled when deps.enabled=false — no git calls, no findings", async () => {
    await seedWorkspace(db);
    const checkAncestor = makeCheckAncestor(false);

    const result = await scanDoneUnmergedWorkspaces({ database: db, checkAncestor, countCommits: makeCountCommits(5), enabled: false, reopenToInReview: true });

    expect(checkAncestor).not.toHaveBeenCalled();
    expect(result.findings).toHaveLength(0);
    expect(result.reopened).toBe(0);
  });

  it("is disabled when the DB preference is set to 'false'", async () => {
    const { issueId } = await seedWorkspace(db);
    const checkAncestor = makeCheckAncestor(false);
    const now = new Date().toISOString();

    await db.insert(preferences).values({ key: "done_unmerged_scanner_enabled", value: "false", updatedAt: now })
      .onConflictDoUpdate({ target: preferences.key, set: { value: "false", updatedAt: now } });

    const result = await scanDoneUnmergedWorkspaces({ database: db, checkAncestor, countCommits: makeCountCommits(5), reopenToInReview: true });

    expect(checkAncestor).not.toHaveBeenCalled();
    expect(result.findings).toHaveLength(0);

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");
  });

  it("is idempotent — after re-open the issue is In Review and no longer scanned as a violation", async () => {
    const { issueId } = await seedWorkspace(db);
    const checkAncestor = makeCheckAncestor(false);
    const countCommits = makeCountCommits(2);

    const first = await scanDoneUnmergedWorkspaces({ database: db, checkAncestor, countCommits, reopenToInReview: true });
    expect(first.reopened).toBe(1);

    // After re-open, issue is now In Review — scanner must not touch it again.
    const checkAncestorSecond = makeCheckAncestor(false);
    const second = await scanDoneUnmergedWorkspaces({ database: db, checkAncestor: checkAncestorSecond, countCommits, reopenToInReview: true });

    expect(second.findings).toHaveLength(0);
    expect(second.reopened).toBe(0);
    expect(checkAncestorSecond).not.toHaveBeenCalled();

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("In Review");
  });
});
