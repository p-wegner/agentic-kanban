import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { projects, projectStatuses, issues, workspaces, repos } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import type { Database } from "../db/index.js";
import { findCrossProjectBranchHolders } from "../repositories/repo.repository.js";

/**
 * #110 cross-project shared-sibling guard: the SAME git repo can be registered as a
 * sibling under two different projects. Git allows only one worktree per branch, so
 * two projects driving that shared repo on the SAME branch would silently share one
 * worktree. findCrossProjectBranchHolders detects a live workspace in ANOTHER project
 * already holding a branch in a repo path, so provisioning can refuse instead of adopt.
 */

const SHARED_REPO = "C:\\projects\\toy\\auth-svc";
const BRANCH = "feature/collide-xproj";

describe("findCrossProjectBranchHolders (#110)", () => {
  let db: TestDb;
  let database: Database;
  const projectA = randomUUID();
  const projectB = randomUUID();
  const issueByProject = new Map<string, string>();

  async function makeProject(id: string, name: string): Promise<void> {
    const now = new Date(Date.now() - 120_000).toISOString();
    await db.insert(projects).values({
      id, name, repoPath: `C:\\projects\\toy\\${name}`, repoName: name,
      defaultBranch: "main", createdAt: now, updatedAt: now,
    });
    const statusId = randomUUID();
    await db.insert(projectStatuses).values({ id: statusId, projectId: id, name: "Todo", sortOrder: 0, isDefault: true, createdAt: now });
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, issueNumber: 1, title: "T", sortOrder: 0, statusId, projectId: id, createdAt: now, updatedAt: now });
    issueByProject.set(id, issueId);
  }

  async function insertWsRepo(opts: {
    projectId: string; status?: string; branch?: string; path?: string;
  }): Promise<string> {
    const wsId = randomUUID();
    const now = new Date(Date.now() - 90_000).toISOString();
    await db.insert(workspaces).values({
      id: wsId, issueId: issueByProject.get(opts.projectId)!, branch: opts.branch ?? BRANCH,
      status: opts.status ?? "active", workingDir: `C:\\wd\\${wsId}`,
      createdAt: now, updatedAt: now,
    });
    // workspace-scoped repo row for the shared sibling
    await db.insert(repos).values({
      id: randomUUID(), workspaceId: wsId, projectId: opts.projectId,
      path: opts.path ?? SHARED_REPO, name: "auth-svc",
      branch: opts.branch ?? BRANCH, baseBranch: "main",
      worktreePath: `${(opts.path ?? SHARED_REPO)}\\..\\.worktrees\\auth-svc\\x`, createdAt: now,
    });
    return wsId;
  }

  beforeEach(async () => {
    ({ db } = createTestDb());
    database = db as unknown as Database;
    await makeProject(projectA, "orders");
    await makeProject(projectB, "backend");
  });

  it("detects a live workspace in ANOTHER project holding the same branch in the shared repo", async () => {
    const otherWs = await insertWsRepo({ projectId: projectB });
    const holders = await findCrossProjectBranchHolders(
      { repoPath: SHARED_REPO, branch: BRANCH, projectId: projectA }, database,
    );
    expect(holders.map((h) => h.workspaceId)).toEqual([otherWs]);
    expect(holders[0].projectId).toBe(projectB);
  });

  it("does NOT report SAME-project holders (intended reuse: reconciler/relaunch)", async () => {
    await insertWsRepo({ projectId: projectA });
    const holders = await findCrossProjectBranchHolders(
      { repoPath: SHARED_REPO, branch: BRANCH, projectId: projectA }, database,
    );
    expect(holders).toEqual([]);
  });

  it("does NOT report a DIFFERENT branch in the same shared repo (the isolated normal case)", async () => {
    await insertWsRepo({ projectId: projectB, branch: "feature/ak-56-other" });
    const holders = await findCrossProjectBranchHolders(
      { repoPath: SHARED_REPO, branch: BRANCH, projectId: projectA }, database,
    );
    expect(holders).toEqual([]);
  });

  it("does NOT report a CLOSED workspace (its rows survive only as merge audit trail)", async () => {
    await insertWsRepo({ projectId: projectB, status: "closed" });
    const holders = await findCrossProjectBranchHolders(
      { repoPath: SHARED_REPO, branch: BRANCH, projectId: projectA }, database,
    );
    expect(holders).toEqual([]);
  });

  it("matches repo path case-insensitively / separator-insensitively but not a different repo", async () => {
    await insertWsRepo({ projectId: projectB, path: "C:/projects/toy/other-svc" });
    const holders = await findCrossProjectBranchHolders(
      { repoPath: SHARED_REPO, branch: BRANCH, projectId: projectA }, database,
    );
    expect(holders).toEqual([]);
  });
});
