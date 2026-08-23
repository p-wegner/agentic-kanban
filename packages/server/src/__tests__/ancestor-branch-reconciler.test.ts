/**
 * Integration tests for reconcileAncestorBranchWorkspaces (ticket #576).
 *
 * Acceptance criteria: seed a workspace whose branch is already an ancestor of
 * base with issue=In Review; run the reconciler; issue becomes Done.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { eq } from "drizzle-orm";
import { issueComments, issues, preferences, projectStatuses, projects, workspaces, workspaceDiffStatCache } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { reconcileAncestorBranchWorkspaces } from "../startup/ancestor-branch-reconciler.js";
import { buildWorkspaceSummaryMap } from "../services/workspace-summary.service.js";
import * as realGitService from "../services/git.service.js";
import { insertWorkspaceRepo, listWorkspaceRepos } from "../repositories/repo.repository.js";
import type { BranchTipAncestryResult } from "@agentic-kanban/shared/lib/git-service";
import { GIT_HEAVY_TEST_TIMEOUT_MS } from "./helpers/timeouts.js";

type CheckAncestor = (repoPath: string, branch: string, baseBranch: string, worktreeDir?: string) => Promise<BranchTipAncestryResult>;
type CountCommits = (repoPath: string, baseSha: string, branchSha: string) => Promise<number>;

function makeCheckAncestor(isAncestor: boolean): CheckAncestor {
  return vi.fn(async (_repo, branch, base) => {
    if (isAncestor) {
      return { isAncestor: true as const, branchSha: `sha-${branch}`, baseSha: `sha-${base}` };
    }
    return { isAncestor: false as const, branchSha: `sha-${branch}`, baseSha: `sha-${base}` };
  });
}

function makeCountCommits(count: number): CountCommits {
  return vi.fn(async () => count);
}

async function seedWorkspace(
  db: ReturnType<typeof createTestDb>["db"],
  opts: {
    statusName?: string;
    wsStatus?: string;
    isDirect?: boolean;
    mergedAt?: string | null;
    readyForMerge?: boolean;
    staleCachedDiff?: boolean;
  } = {},
) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const statusName = opts.statusName ?? "In Review";
  // #668: a project may not hold two statuses with the same name. When the caller asks for a
  // "Done" fixture, the primary status IS the Done status — inserting a second one seeded the
  // exact duplication the constraint now refuses, and this fixture was doing it.
  const doneStatusId = statusName === "Done" ? statusId : randomUUID();
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
      name: statusName,
      sortOrder: 2,
      isDefault: false,
      createdAt: now,
    },
    ...(doneStatusId === statusId
      ? []
      : [{
          id: doneStatusId,
          projectId,
          name: "Done",
          sortOrder: 3,
          isDefault: false,
          createdAt: now,
        }]),
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
    readyForMerge: opts.readyForMerge ?? false,
    mergedAt: opts.mergedAt !== undefined ? opts.mergedAt : null,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });
  // #815: the diff-stat memo moved to `workspace_diff_stat_cache`. NO row is exactly what the
  // five NULL columns were — never diffed — so the non-stale case seeds nothing at all.
  if (opts.staleCachedDiff) {
    await db.insert(workspaceDiffStatCache).values({
      workspaceId, checkedAt: now, headSha: "pre-merge-head",
      filesChanged: 2, insertions: 10, deletions: 1,
    });
  }

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
    const countCommits = makeCountCommits(1);

    const count = await reconcileAncestorBranchWorkspaces({ pathExists: () => true, database: db, checkAncestor, countCommits });

    expect(count).toBe(1);

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");

    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
    expect(ws.mergedAt).toBeTruthy();
  });

  it("is a no-op when issue is In Progress (active workspace must never be reaped)", async () => {
    const { issueId } = await seedWorkspace(db, { statusName: "In Progress", wsStatus: "active" });
    const checkAncestor = makeCheckAncestor(true);

    const count = await reconcileAncestorBranchWorkspaces({ pathExists: () => true, database: db, checkAncestor });

    expect(count).toBe(0);
    expect(checkAncestor).not.toHaveBeenCalled();
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("In Progress");
  });

  it("reconciles ready In Progress work after a dropped merge response and clears stale board diff", async () => {
    const { issueId, workspaceId } = await seedWorkspace(db, {
      statusName: "In Progress",
      wsStatus: "idle",
      readyForMerge: true,
      staleCachedDiff: true,
    });
    const checkAncestor = makeCheckAncestor(true);
    const countCommits = makeCountCommits(2);

    const count = await reconcileAncestorBranchWorkspaces({ pathExists: () => true, database: db, checkAncestor, countCommits });

    expect(count).toBe(1);
    expect(checkAncestor).toHaveBeenCalled();

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");

    const [ws] = await db
      .select({
        status: workspaces.status,
        readyForMerge: workspaces.readyForMerge,
        mergedAt: workspaces.mergedAt,
        workingDir: workspaces.workingDir,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
    expect(ws.readyForMerge).toBe(false);
    expect(ws.mergedAt).toBeTruthy();
    expect(ws.workingDir).toBeNull();

    const summaryMap = await buildWorkspaceSummaryMap([issueId], "master", db, new Set([issueId]));
    const main = summaryMap.get(issueId)?.main;
    expect(main?.status).toBe("closed");
    expect(main?.mergedAt).toBeTruthy();
    expect(main?.diffStats).toBeUndefined();
    expect(main?.commitCount).toBeNull();
  });

  it("does not reconcile ready In Progress work while the workspace is active", async () => {
    const { issueId, workspaceId } = await seedWorkspace(db, {
      statusName: "In Progress",
      wsStatus: "active",
      readyForMerge: true,
    });
    const checkAncestor = makeCheckAncestor(true);
    const countCommits = makeCountCommits(2);

    const count = await reconcileAncestorBranchWorkspaces({ pathExists: () => true, database: db, checkAncestor, countCommits });

    expect(count).toBe(0);
    expect(checkAncestor).not.toHaveBeenCalled();

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("In Progress");

    const [ws] = await db
      .select({ status: workspaces.status, readyForMerge: workspaces.readyForMerge, mergedAt: workspaces.mergedAt })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("active");
    expect(ws.readyForMerge).toBe(true);
    expect(ws.mergedAt).toBeNull();
  });

  it("is a no-op when branch tip is NOT an ancestor", async () => {
    const { issueId } = await seedWorkspace(db, { statusName: "In Review" });
    const checkAncestor = makeCheckAncestor(false);

    const count = await reconcileAncestorBranchWorkspaces({ pathExists: () => true, database: db, checkAncestor });

    expect(count).toBe(0);
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("In Review");
  });

  it("is a no-op when issue is already Done (terminal status)", async () => {
    const { workspaceId } = await seedWorkspace(db, { statusName: "Done" });
    const checkAncestor = makeCheckAncestor(true);

    const count = await reconcileAncestorBranchWorkspaces({ pathExists: () => true, database: db, checkAncestor });

    expect(count).toBe(0);
    expect(checkAncestor).not.toHaveBeenCalled();

    const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("idle");
  });

  it("skips direct workspaces", async () => {
    const { issueId } = await seedWorkspace(db, { statusName: "In Review", isDirect: true });
    const checkAncestor = makeCheckAncestor(true);

    const count = await reconcileAncestorBranchWorkspaces({ pathExists: () => true, database: db, checkAncestor });

    expect(count).toBe(0);
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("In Review");
  });

  it("skips workspaces that already have mergedAt set (handled by reconcileSilentlyMergedWorkspaces)", async () => {
    const now = new Date().toISOString();
    const { issueId } = await seedWorkspace(db, { statusName: "In Review", mergedAt: now });
    const checkAncestor = makeCheckAncestor(true);

    const count = await reconcileAncestorBranchWorkspaces({ pathExists: () => true, database: db, checkAncestor });

    expect(count).toBe(0);
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("In Review");
  });

  it("skips closed workspaces", async () => {
    const { issueId } = await seedWorkspace(db, { statusName: "In Review", wsStatus: "closed" });
    const checkAncestor = makeCheckAncestor(true);

    const count = await reconcileAncestorBranchWorkspaces({ pathExists: () => true, database: db, checkAncestor });

    expect(count).toBe(0);
    expect(checkAncestor).not.toHaveBeenCalled();
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("In Review");
  });

  it("is idempotent — running twice produces no change after first run", async () => {
    const { issueId } = await seedWorkspace(db, { statusName: "In Review" });
    const checkAncestor = makeCheckAncestor(true);
    const countCommits = makeCountCommits(1);

    const first = await reconcileAncestorBranchWorkspaces({ pathExists: () => true, database: db, checkAncestor, countCommits });
    const second = await reconcileAncestorBranchWorkspaces({ pathExists: () => true, database: db, checkAncestor, countCommits });

    expect(first).toBe(1);
    expect(second).toBe(0);

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");
  });

  it("regression #581: freshly-created 0-commit workspace (branchSha===baseSha) is left untouched", async () => {
    // A brand-new workspace has 0 commits: countCommits returns 0 for baseSha..branchSha.
    // The reconciler must NOT reap it even though it is "trivially an ancestor".
    const { issueId, workspaceId } = await seedWorkspace(db, { statusName: "In Review" });
    const checkAncestor = makeCheckAncestor(true);
    const countCommits = makeCountCommits(0);

    const count = await reconcileAncestorBranchWorkspaces({ pathExists: () => true, database: db, checkAncestor, countCommits });

    expect(count).toBe(0);
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("In Review");
    const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("idle");
  });

  it("regression #581: stale 0-commit workspace whose base advanced (In Review) is left untouched", async () => {
    // A workspace created when base was at commit X; base later advanced to Y.
    // The branch still has 0 unique commits (tip == original base == ancestor of current base).
    // branchSha !== baseSha (the SHAs differ because base advanced), but countCommits returns 0.
    // A guard using only branchSha===baseSha would miss this case and wrongly reconcile.
    const { issueId, workspaceId } = await seedWorkspace(db, { statusName: "In Review" });
    const checkAncestor = makeCheckAncestor(true);
    const countCommits = makeCountCommits(0);

    const count = await reconcileAncestorBranchWorkspaces({ pathExists: () => true, database: db, checkAncestor, countCommits });

    expect(count).toBe(0);
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("In Review");
    const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("idle");
  });

  it("regression #581: 0-commit In-Progress workspace is left untouched (status guard)", async () => {
    // Belt-and-suspenders: In-Progress without readyForMerge is filtered before any git call.
    const { issueId, workspaceId } = await seedWorkspace(db, { statusName: "In Progress", wsStatus: "idle" });
    const checkAncestor = makeCheckAncestor(true);
    const countCommits = makeCountCommits(0);

    const count = await reconcileAncestorBranchWorkspaces({ pathExists: () => true, database: db, checkAncestor, countCommits });

    expect(count).toBe(0);
    expect(checkAncestor).not.toHaveBeenCalled(); // filtered out by In Progress guard
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("In Progress");
    const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("idle");
  });

  it("regression #585: freshly-launched In-Progress active workspace with 0 commits is NEVER auto-Doned (incident scenario)", async () => {
    // Exact incident pattern from cycles 39-40: a freshly-launched workspace had
    // wsStatus="active" and 0 unique commits (branch tip == base HEAD).
    // The ancestor-branch reconciler auto-Doned it, flipping its issue to Done
    // while master never advanced = mass silent-merge-loss.
    // This test pins BOTH guards: the In-Progress readiness/status filter AND the
    // uniqueCommitCount guard (#581), so a regression in either fails CI.
    const { issueId, workspaceId } = await seedWorkspace(db, { statusName: "In Progress", wsStatus: "active" });
    const checkAncestor = makeCheckAncestor(true);
    const countCommits = makeCountCommits(0);

    const count = await reconcileAncestorBranchWorkspaces({ pathExists: () => true, database: db, checkAncestor, countCommits });

    expect(count).toBe(0);
    // The In-Progress status guard filters before git is consulted.
    expect(checkAncestor).not.toHaveBeenCalled();
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("In Progress");
    const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("active");
  });

  it("regression #585: positive case — genuinely merged workspace (In Review, >0 unique commits) IS reconciled to Done", async () => {
    // Counterpart to the incident guard: a workspace whose branch tip is a real
    // ancestor AND has >0 unique commits (i.e. real work was merged into base)
    // MUST be reconciled to Done. Verifies the uniqueCommitCount guard is called
    // and does not block legitimate reconciliation.
    const { issueId, workspaceId } = await seedWorkspace(db, { statusName: "In Review", wsStatus: "idle" });
    const checkAncestor = makeCheckAncestor(true);
    const countCommits = makeCountCommits(3); // 3 real commits on the branch

    const count = await reconcileAncestorBranchWorkspaces({ pathExists: () => true, database: db, checkAncestor, countCommits });

    expect(count).toBe(1);
    expect(checkAncestor).toHaveBeenCalled();
    expect(countCommits).toHaveBeenCalled();
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");
    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
    expect(ws.mergedAt).toBeTruthy();
  });

  it("regression #582: performs zero mutations when disabled via deps.enabled=false", async () => {
    // Regression guard: disabling the reconciler (hot-reload-safe pref path) must
    // result in zero mutations even when there are eligible workspaces.
    const { issueId, workspaceId } = await seedWorkspace(db, { statusName: "In Review" });
    const checkAncestor = makeCheckAncestor(true);
    const countCommits = makeCountCommits(1);

    const count = await reconcileAncestorBranchWorkspaces({ pathExists: () => true, database: db, checkAncestor, countCommits, enabled: false });

    expect(count).toBe(0);
    expect(checkAncestor).not.toHaveBeenCalled();

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("In Review");

    const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("idle");
  });

  it("regression #582: performs zero mutations when disabled via DB preference", async () => {
    // Regression guard for the hot-reload scenario: even if an old setInterval keeps
    // firing after tsx --watch re-evaluates the module, the live pref read at tick time
    // causes the reconciler to no-op — no restart required to take effect.
    const { issueId, workspaceId } = await seedWorkspace(db, { statusName: "In Review" });
    const checkAncestor = makeCheckAncestor(true);
    const countCommits = makeCountCommits(1);

    // Write the disable preference to the DB.
    const now = new Date().toISOString();
    await db.insert(preferences).values({ key: "reconciler_ancestor_branch_enabled", value: "false", updatedAt: now })
      .onConflictDoUpdate({ target: preferences.key, set: { value: "false", updatedAt: now } });

    const count = await reconcileAncestorBranchWorkspaces({ pathExists: () => true, database: db, checkAncestor, countCommits });

    expect(count).toBe(0);
    expect(checkAncestor).not.toHaveBeenCalled();

    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("In Review");

    const [ws] = await db.select({ status: workspaces.status }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("idle");
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
    const countCommits = makeCountCommits(1);

    const count = await reconcileAncestorBranchWorkspaces({ pathExists: () => true, database: db, checkAncestor, countCommits });

    expect(count).toBe(1);
    const [issue2] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId2));
    const [status2] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue2.statusId));
    expect(status2.name).toBe("Done");
  });
});

// ─── Sibling-aware terminalization (#151) ────────────────────────────────────
//
// The leading branch alone becoming an ancestor of base does NOT mean the whole
// multi-repo workspace is done — a sibling repo may still hold unlanded work.
// These tests use a REAL temp git repo for the sibling (mirroring
// stranded-sibling-reconciler.test.ts) while the leading repo stays fake/mocked
// via checkAncestor, since no real git call ever touches the leading repoPath.

function exec(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.toString());
    });
  });
}

async function createTempRepo(prefix: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), prefix));
  const dir = join(parent, "repo");
  mkdirSync(dir);
  await exec("git", ["init", "-b", "main"], dir);
  await writeFile(join(dir, "README.md"), "# Test\n");
  await exec("git", ["add", "."], dir);
  await exec("git", ["commit", "-m", "Initial commit"], dir);
  return dir;
}

async function commitFile(dir: string, file: string, content: string, message: string): Promise<void> {
  await writeFile(join(dir, file), content);
  await exec("git", ["add", "."], dir);
  await exec("git", ["commit", "-m", message], dir);
}

describe("reconcileAncestorBranchWorkspaces — sibling-aware terminalization (#151)", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let siblingRepo: string;
  const cleanupDirs: string[] = [];
  const SIBLING_BRANCH = "feature/ak-151-sibling";

  beforeEach(async () => {
    ({ db } = createTestDb());
    siblingRepo = await createTempRepo("kanban-ancestor-sib-");
    cleanupDirs.push(siblingRepo);
  }, GIT_HEAVY_TEST_TIMEOUT_MS);

  afterEach(async () => {
    while (cleanupDirs.length) {
      const dir = cleanupDirs.pop()!;
      try { await rm(join(dir, ".."), { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  async function seedLeadingWorkspace() {
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const statusId = randomUUID();
    const doneStatusId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();

    await db.insert(projects).values({
      id: projectId, name: "Test", repoPath: "/repo", repoName: "repo", defaultBranch: "master", createdAt: now, updatedAt: now,
    });
    await db.insert(projectStatuses).values([
      { id: statusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now },
      { id: doneStatusId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
    ]);
    await db.insert(issues).values({
      id: issueId, issueNumber: 151, title: "Multi-repo issue", priority: "medium", sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
    });
    await db.insert(workspaces).values({
      id: workspaceId, issueId, branch: "feature/ak-151-lead", workingDir: "/repo/.worktrees/ws", baseBranch: "master",
      isDirect: false, status: "idle", readyForMerge: false, mergedAt: null, provider: "claude", createdAt: now, updatedAt: now,
    });

    return { projectId, issueId, workspaceId };
  }

  async function insertPendingSibling(workspaceId: string, projectId: string): Promise<string> {
    const worktreePath = await realGitService.createWorktree(siblingRepo, SIBLING_BRANCH, "main");
    await commitFile(worktreePath, "change.txt", "sibling work\n", "feat: sibling change");
    await insertWorkspaceRepo({
      workspaceId, projectId, path: siblingRepo, name: "sibling",
      worktreePath, branch: SIBLING_BRANCH, baseBranch: "main",
    }, db);
    return worktreePath;
  }

  async function commentsForIssue(issueId: string): Promise<{ body: string }[]> {
    return db.select({ body: issueComments.body }).from(issueComments).where(eq(issueComments.issueId, issueId));
  }

  it("does NOT Done the issue when a sibling repo still has unmerged commits, and lands the sibling instead", async () => {
    const { projectId, issueId, workspaceId } = await seedLeadingWorkspace();
    await insertPendingSibling(workspaceId, projectId);

    const checkAncestor = makeCheckAncestor(true);
    const countCommits = makeCountCommits(1);

    const count = await reconcileAncestorBranchWorkspaces({ pathExists: () => true, database: db, checkAncestor, countCommits, gitService: realGitService });

    expect(count).toBe(1);

    // The issue converged to Done — the sibling's work landed first.
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("Done");

    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("closed");
    expect(ws.mergedAt).toBeTruthy();

    // Sibling mergedHeadSha stamped, its work is on the sibling's main, and its worktree/branch cleaned up.
    const [repoRow] = await listWorkspaceRepos(workspaceId, db);
    expect(repoRow.mergedHeadSha).toMatch(/^[0-9a-f]{40}$/);
    const log = await exec("git", ["log", "--oneline", "main"], siblingRepo);
    expect(log).toContain("sibling change");
    const branches = await exec("git", ["branch", "--list", SIBLING_BRANCH], siblingRepo);
    expect(branches.trim()).toBe("");

    const comments = await commentsForIssue(issueId);
    expect(comments.some((c) => /landed 1 sibling repo merge/i.test(c.body))).toBe(true);
  }, GIT_HEAVY_TEST_TIMEOUT_MS);

  it("leaves the issue open (not Done) when the pending sibling cannot land cleanly", async () => {
    const { projectId, issueId, workspaceId } = await seedLeadingWorkspace();
    const worktreePath = await insertPendingSibling(workspaceId, projectId);
    // Conflicting edits so the sibling merge cannot land cleanly.
    await commitFile(worktreePath, "README.md", "# branch version\n", "feat: branch edit");
    await commitFile(siblingRepo, "README.md", "# main version\n", "feat: main edit");

    const checkAncestor = makeCheckAncestor(true);
    const countCommits = makeCountCommits(1);

    const count = await reconcileAncestorBranchWorkspaces({ pathExists: () => true, database: db, checkAncestor, countCommits, gitService: realGitService });

    expect(count).toBe(0);

    // The issue and workspace are left untouched — NOT false-Done.
    const [issue] = await db.select({ statusId: issues.statusId }).from(issues).where(eq(issues.id, issueId));
    const [status] = await db.select({ name: projectStatuses.name }).from(projectStatuses).where(eq(projectStatuses.id, issue.statusId));
    expect(status.name).toBe("In Review");
    const [ws] = await db.select({ status: workspaces.status, mergedAt: workspaces.mergedAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws.status).toBe("idle");
    expect(ws.mergedAt).toBeNull();

    // Nothing destroyed — the sibling branch is preserved.
    const branches = await exec("git", ["branch", "--list", SIBLING_BRANCH], siblingRepo);
    expect(branches.trim()).not.toBe("");
    const mainLog = await exec("git", ["log", "--oneline", "main"], siblingRepo);
    expect(mainLog).not.toContain("branch edit");

    const comments = await commentsForIssue(issueId);
    expect(comments.some((c) => /Ancestor-branch reconciliation found the leading branch/.test(c.body))).toBe(true);
  }, GIT_HEAVY_TEST_TIMEOUT_MS);
});
