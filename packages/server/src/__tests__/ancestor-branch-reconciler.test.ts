/**
 * Integration tests for reconcileAncestorBranchWorkspaces (ticket #576).
 *
 * Acceptance criteria: seed a workspace whose branch is already an ancestor of
 * base with issue=In Review; run the reconciler; issue becomes Done.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { reconcileAncestorBranchWorkspaces } from "../startup/ancestor-branch-reconciler.js";
import type { BranchTipAncestryResult } from "@agentic-kanban/shared/lib/git-service";

type CheckAncestor = (repoPath: string, branch: string, baseBranch: string, worktreeDir?: string) => Promise<BranchTipAncestryResult>;

function makeCheckAncestor(isAncestor: boolean): CheckAncestor {
  return vi.fn(async (_repo, branch, base) => {
    if (isAncestor) {
      return { isAncestor: true as const, branchSha: `sha-${branch}`, baseSha: `sha-${base}` };
    }
    return { isAncestor: false as const, branchSha: `sha-${branch}`, baseSha: `sha-${base}` };
  });
}

async function seedWorkspace(
  db: ReturnType<typeof createTestDb>["db"],
  opts: {
    statusName?: string;
    wsStatus?: string;
    isDirect?: boolean;
    mergedAt?: string | null;
  } = {},
) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
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
    {
      id: statusId,
      projectId,
      name: opts.statusName ?? "In Review",
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
    issueNumber: 576,
    title: "Stranded issue",
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
    branch: "feature/ak-576-test",
    workingDir: "/repo/.worktrees/ws",
    baseBranch: "master",
    isDirect: opts.isDirect ?? false,
    status: opts.wsStatus ?? "idle",
    readyForMerge: false,
    mergedAt: opts.mergedAt !== undefined ? opts.mergedAt : null,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });

  return { projectId, issueId, workspaceId, statusId, doneStatusId };
}

describe("reconcileAncestorBranchWorkspaces", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("moves issue to Done when branch tip is an ancestor of base (In Review case)", async () => {
    const { issueId, workspaceId } = await seedWorkspace(db, { statusName: "In Review" });
    const checkAncestor = makeCheckAncestor(true);

    const count = await reconcileAncestorBranchWorkspaces({ database: db, checkAncestor });

    expect(count).toBe(1);

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");

    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
    expect(ws.mergedAt).toBeTruthy();
  });

  it("moves issue to Done when issue is In Progress (not just In Review)", async () => {
    const { issueId } = await seedWorkspace(db, { statusName: "In Progress", wsStatus: "active" });
    const checkAncestor = makeCheckAncestor(true);

    const count = await reconcileAncestorBranchWorkspaces({ database: db, checkAncestor });

    expect(count).toBe(1);
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");
  });

  it("is a no-op when branch tip is NOT an ancestor", async () => {
    const { issueId } = await seedWorkspace(db, { statusName: "In Review" });
    const checkAncestor = makeCheckAncestor(false);

    const count = await reconcileAncestorBranchWorkspaces({ database: db, checkAncestor });

    expect(count).toBe(0);
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("In Review");
  });

  it("is a no-op when issue is already Done (terminal status)", async () => {
    const { workspaceId } = await seedWorkspace(db, { statusName: "Done" });
    const checkAncestor = makeCheckAncestor(true);

    const count = await reconcileAncestorBranchWorkspaces({ database: db, checkAncestor });

    expect(count).toBe(0);
    expect(checkAncestor).not.toHaveBeenCalled();

    const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("idle");
  });

  it("skips direct workspaces", async () => {
    const { issueId } = await seedWorkspace(db, { statusName: "In Review", isDirect: true });
    const checkAncestor = makeCheckAncestor(true);

    const count = await reconcileAncestorBranchWorkspaces({ database: db, checkAncestor });

    expect(count).toBe(0);
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("In Review");
  });

  it("skips workspaces that already have mergedAt set (handled by reconcileSilentlyMergedWorkspaces)", async () => {
    const now = new Date().toISOString();
    const { issueId } = await seedWorkspace(db, { statusName: "In Review", mergedAt: now });
    const checkAncestor = makeCheckAncestor(true);

    const count = await reconcileAncestorBranchWorkspaces({ database: db, checkAncestor });

    expect(count).toBe(0);
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("In Review");
  });

  it("skips closed workspaces", async () => {
    const { issueId } = await seedWorkspace(db, { statusName: "In Review", wsStatus: "closed" });
    const checkAncestor = makeCheckAncestor(true);

    const count = await reconcileAncestorBranchWorkspaces({ database: db, checkAncestor });

    expect(count).toBe(0);
    expect(checkAncestor).not.toHaveBeenCalled();
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("In Review");
  });

  it("is idempotent — running twice produces no change after first run", async () => {
    const { issueId } = await seedWorkspace(db, { statusName: "In Review" });
    const checkAncestor = makeCheckAncestor(true);

    const first = await reconcileAncestorBranchWorkspaces({ database: db, checkAncestor });
    const second = await reconcileAncestorBranchWorkspaces({ database: db, checkAncestor });

    expect(first).toBe(1);
    expect(second).toBe(0);

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");
  });

  it("continues processing other workspaces when git check throws for one", async () => {
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const reviewStatusId = randomUUID();
    const doneStatusId = randomUUID();
    const issueId1 = randomUUID();
    const issueId2 = randomUUID();
    const wsId1 = randomUUID();
    const wsId2 = randomUUID();

    await db.insert(projects).values({ id: projectId, name: "P", repoPath: "/repo", repoName: "repo", defaultBranch: "master", createdAt: now, updatedAt: now });
    await db.insert(projectStatuses).values([
      { id: reviewStatusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now },
      { id: doneStatusId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
    ]);
    await db.insert(issues).values([
      { id: issueId1, issueNumber: 1, title: "Issue 1", priority: "medium", sortOrder: 0, statusId: reviewStatusId, projectId, createdAt: now, updatedAt: now },
      { id: issueId2, issueNumber: 2, title: "Issue 2", priority: "medium", sortOrder: 1, statusId: reviewStatusId, projectId, createdAt: now, updatedAt: now },
    ]);
    await db.insert(workspaces).values([
      { id: wsId1, issueId: issueId1, branch: "feature/ws1", workingDir: "/repo/.w/1", baseBranch: "master", isDirect: false, status: "idle", readyForMerge: false, mergedAt: null, provider: "claude", createdAt: now, updatedAt: now },
      { id: wsId2, issueId: issueId2, branch: "feature/ws2", workingDir: "/repo/.w/2", baseBranch: "master", isDirect: false, status: "idle", readyForMerge: false, mergedAt: null, provider: "claude", createdAt: now, updatedAt: now },
    ]);

    let callNum = 0;
    const checkAncestor: CheckAncestor = vi.fn(async (_repo, branch, base) => {
      callNum++;
      if (callNum === 1) throw new Error("git exploded");
      return { isAncestor: true as const, branchSha: `sha-${branch}`, baseSha: `sha-${base}` };
    });

    const count = await reconcileAncestorBranchWorkspaces({ database: db, checkAncestor });

    expect(count).toBe(1);
    const [issue2] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId2));
    const [status2] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue2.statusId));
    expect(status2.name).toBe("Done");
  });
});
