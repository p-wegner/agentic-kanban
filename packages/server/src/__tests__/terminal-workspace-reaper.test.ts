import { randomUUID } from "node:crypto";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { issueComments, issues, projectStatuses, projects, sessions, workspaces } from "@agentic-kanban/shared/schema";
import type { BranchTipAncestryResult } from "@agentic-kanban/shared/lib/git-service";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { reapTerminalWorkspaces } from "../startup/terminal-workspace-reaper.js";
import { insertWorkspaceRepo, listWorkspaceRepos } from "../repositories/repo.repository.js";

type CheckAncestor = (repoPath: string, branch: string, baseBranch: string, worktreeDir?: string) => Promise<BranchTipAncestryResult>;
type CountCommits = (repoPath: string, baseSha: string, branchSha: string) => Promise<number>;

let db: TestDb;

function makeCheckAncestor(isAncestor: boolean): CheckAncestor {
  return vi.fn(async (_repo, branch, base) => {
    if (isAncestor) return { isAncestor: true as const, branchSha: `sha-${branch}`, baseSha: `sha-${base}` };
    return { isAncestor: false as const, branchSha: `sha-${branch}`, baseSha: `sha-${base}` };
  });
}

function makeCountCommits(count: number): CountCommits {
  return vi.fn(async () => count);
}

async function seedWorkspace(opts: {
  issueStatus?: "Done" | "Cancelled" | "In Progress";
  wsStatus?: string;
  readyForMerge?: boolean;
  mergedAt?: string | null;
  withRunningSession?: boolean;
} = {}) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    name: "Terminal Reaper Test",
    repoPath: "/repo",
    repoName: "repo",
    defaultBranch: "master",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: statusId,
    projectId,
    name: opts.issueStatus ?? "Done",
    sortOrder: 1,
    isDefault: false,
    createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId,
    issueNumber: 816,
    title: "Terminal workspace debris",
    statusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: `feature/ak-816-${workspaceId.slice(0, 8)}`,
    workingDir: `/repo/.worktrees/${workspaceId}`,
    baseBranch: "master",
    isDirect: false,
    status: opts.wsStatus ?? "idle",
    readyForMerge: opts.readyForMerge ?? true,
    mergedAt: opts.mergedAt ?? null,
    provider: "codex",
    createdAt: now,
    updatedAt: now,
  });

  if (opts.withRunningSession) {
    await db.insert(sessions).values({
      id: randomUUID(),
      workspaceId,
      executor: "codex",
      status: "running",
      startedAt: now,
    });
  }

  return { issueId, workspaceId, projectId };
}

async function getWorkspace(workspaceId: string) {
  const [row] = await db
    .select({
      status: workspaces.status,
      closedAt: workspaces.closedAt,
      mergedAt: workspaces.mergedAt,
      readyForMerge: workspaces.readyForMerge,
      workingDir: workspaces.workingDir,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return row;
}

beforeEach(() => {
  ({ db } = createTestDb());
});

describe("terminal workspace reaper", () => {
  it("closes one stale idle workspace for a Done issue when git says the branch is merged", async () => {
    const { workspaceId } = await seedWorkspace({ issueStatus: "Done", wsStatus: "idle" });
    const checkAncestor = makeCheckAncestor(true);

    const result = await reapTerminalWorkspaces({ database: db, pathExists: () => true, checkAncestor });

    expect(result.reaped).toBe(1);
    expect(checkAncestor).toHaveBeenCalledTimes(1);
    const ws = await getWorkspace(workspaceId);
    expect(ws.status).toBe("closed");
    expect(ws.closedAt).toBeTruthy();
    expect(ws.mergedAt).toBeTruthy();
    expect(ws.readyForMerge).toBe(false);
    expect(ws.workingDir).toBeTruthy();
  });

  it("does not close a terminal workspace whose branch still has commits ahead of base", async () => {
    const { workspaceId } = await seedWorkspace({ issueStatus: "Done", wsStatus: "idle", mergedAt: "2026-06-14T00:00:00.000Z" });
    const checkAncestor = makeCheckAncestor(false);
    const countCommits = makeCountCommits(2);

    const result = await reapTerminalWorkspaces({ database: db, pathExists: () => true, checkAncestor, countCommits });

    expect(result.reaped).toBe(0);
    expect(result.skippedAhead).toBe(1);
    const ws = await getWorkspace(workspaceId);
    expect(ws.status).toBe("idle");
    expect(ws.closedAt).toBeNull();
    expect(ws.mergedAt).toBe("2026-06-14T00:00:00.000Z");
  });

  it("closes a Cancelled terminal workspace with no commits ahead without stamping mergedAt", async () => {
    const { workspaceId } = await seedWorkspace({ issueStatus: "Cancelled", wsStatus: "reviewing" });
    const checkAncestor = makeCheckAncestor(false);
    const countCommits = makeCountCommits(0);

    const result = await reapTerminalWorkspaces({ database: db, pathExists: () => true, checkAncestor, countCommits });

    expect(result.reaped).toBe(1);
    const ws = await getWorkspace(workspaceId);
    expect(ws.status).toBe("closed");
    expect(ws.mergedAt).toBeNull();
  });

  it("skips terminal workspaces with a running session", async () => {
    const { workspaceId } = await seedWorkspace({ issueStatus: "Done", wsStatus: "idle", withRunningSession: true });
    const checkAncestor = makeCheckAncestor(true);

    const result = await reapTerminalWorkspaces({ database: db, pathExists: () => true, checkAncestor });

    expect(result.reaped).toBe(0);
    expect(result.skippedRunning).toBe(1);
    expect(checkAncestor).not.toHaveBeenCalled();
    expect((await getWorkspace(workspaceId)).status).toBe("idle");
  });

  it("reaps at most one workspace per run", async () => {
    const first = await seedWorkspace({ issueStatus: "Done", wsStatus: "idle" });
    const second = await seedWorkspace({ issueStatus: "Done", wsStatus: "idle" });

    const result = await reapTerminalWorkspaces({ database: db, pathExists: () => true, checkAncestor: makeCheckAncestor(true) });

    expect(result.reaped).toBe(1);
    const statuses = [(await getWorkspace(first.workspaceId)).status, (await getWorkspace(second.workspaceId)).status];
    expect(statuses.filter((status) => status === "closed")).toHaveLength(1);
    expect(statuses.filter((status) => status === "idle")).toHaveLength(1);
  });

  it("ignores non-terminal issue statuses", async () => {
    const { workspaceId } = await seedWorkspace({ issueStatus: "In Progress", wsStatus: "idle" });
    const checkAncestor = makeCheckAncestor(true);

    const result = await reapTerminalWorkspaces({ database: db, pathExists: () => true, checkAncestor });

    expect(result.scanned).toBe(0);
    expect(result.reaped).toBe(0);
    expect(checkAncestor).not.toHaveBeenCalled();
    expect((await getWorkspace(workspaceId)).status).toBe("idle");
  });

  // #153: verifyNoAheadWork only judges the LEADING repo. A multi-repo workspace with an
  // unmerged sibling must still be closeable (issue is terminal, worktrees are never
  // touched here), but the reap must not silently orphan the sibling's commits — it has
  // to surface them via an issue comment, and must leave the sibling row untouched.
  describe("multi-repo sibling audit", () => {
    const SIBLING_PATH = "/extra";

    it("closes the workspace but leaves an issue comment enumerating an unmerged sibling", async () => {
      const { issueId, workspaceId, projectId } = await seedWorkspace({ issueStatus: "Done", wsStatus: "idle" });
      await insertWorkspaceRepo({
        workspaceId,
        projectId,
        path: SIBLING_PATH,
        name: "extra",
        worktreePath: `${SIBLING_PATH}/.worktrees/ws`,
        branch: "feature/ak-816-sibling",
        baseBranch: "master",
      }, db);

      const checkAncestor = makeCheckAncestor(true); // leading repo reads fully merged
      const revParseRef = vi.fn(async (_repo: string, ref: string) => `sha-${ref}`);
      const countCommits = vi.fn(async (repoPath: string) => (repoPath === SIBLING_PATH ? 3 : 0));

      const result = await reapTerminalWorkspaces({ database: db, pathExists: () => true, checkAncestor, countCommits, revParseRef });

      expect(result.reaped).toBe(1);
      const ws = await getWorkspace(workspaceId);
      expect(ws.status).toBe("closed");

      // Sibling row/worktree untouched by the reaper — it never calls removeWorktree.
      const siblingRows = await listWorkspaceRepos(workspaceId, db);
      expect(siblingRows).toHaveLength(1);
      expect(siblingRows[0].mergedHeadSha).toBeNull();

      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments).toHaveLength(1);
      expect(comments[0].kind).toBe("note");
      expect(comments[0].body).toContain("extra");
      expect(comments[0].body).toContain("feature/ak-816-sibling");
      expect(comments[0].body).toContain("unmerged");
    });

    it("does not comment when every sibling has already landed (mergedHeadSha stamped)", async () => {
      const { issueId, workspaceId, projectId } = await seedWorkspace({ issueStatus: "Done", wsStatus: "idle" });
      await insertWorkspaceRepo({
        workspaceId,
        projectId,
        path: SIBLING_PATH,
        name: "extra",
        worktreePath: `${SIBLING_PATH}/.worktrees/ws`,
        branch: "feature/ak-816-sibling",
        baseBranch: "master",
      }, db);
      const [row] = await listWorkspaceRepos(workspaceId, db);
      const { setWorkspaceRepoMergedSha } = await import("../repositories/repo.repository.js");
      await setWorkspaceRepoMergedSha(row.id, "landed-sha", db);

      const checkAncestor = makeCheckAncestor(true);

      const result = await reapTerminalWorkspaces({ database: db, pathExists: () => true, checkAncestor });

      expect(result.reaped).toBe(1);
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments).toHaveLength(0);
    });
  });
});
