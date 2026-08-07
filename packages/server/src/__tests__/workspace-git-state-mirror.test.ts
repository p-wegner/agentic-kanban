// @covers workspaces.multiRepo.gitStateMirror [state-transition,regression-guard]
/**
 * Closing a workspace must clear `workingDir` on BOTH sides (#226).
 *
 * The `workspaces` columns and the workspace's `is_leading` repos row hold the same five
 * pieces of git state. Stage 2 dual-wrote them through repository helpers — but
 * `setWorkspaceStatus(..., { set: { workingDir: null } })` was an open escape hatch that
 * could NOT mirror: it lives in `packages/shared` and the mirror lived in the server's
 * `repo.repository`. Four close paths were going through it, so a closed workspace kept a
 * leading row pointing at a worktree that had already been torn down. That is invisible today
 * (the columns are still the read source) and becomes a merge-path bug the moment the row
 * becomes authoritative — which is the whole point of this epic.
 *
 * The fix is structural, not a list of four fixes: `SetWorkspaceStatusOpts["set"]` now EXCLUDES
 * the five mirror columns, so any future caller trying the same thing fails to compile. These
 * tests cover the behaviour that guard forces.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { issues, projectStatuses, projects, repos, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { setWorkspaceWorkingDir, mirrorWorkspaceGitStateToLeadingRepo } from "@agentic-kanban/shared/lib/workspace-git-state";
import { clearWorkspaceWorkingDir, updateWorkspaceClosed } from "../repositories/workspace-crud.repository.js";

type Db = ReturnType<typeof createTestDb>["db"];

const WORKTREE = "/repo/.worktrees/ws-226";

async function seed(db: Db, opts: { withLeadingRow?: boolean } = {}) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo",
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: 226, title: "Issue 226", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-226", workingDir: WORKTREE, baseBranch: "master",
    isDirect: false, status: "idle", readyForMerge: false, provider: "claude",
    createdAt: now, updatedAt: now,
  });
  if (opts.withLeadingRow !== false) {
    await db.insert(repos).values({
      id: randomUUID(), workspaceId, path: "/repo", defaultBranch: "master", isLeading: true,
      worktreePath: WORKTREE, branch: "feature/ak-226", baseBranch: "master", createdAt: now,
    });
  }
  return { workspaceId, issueId };
}

function readBoth(db: Db, workspaceId: string) {
  return Promise.all([
    db.select({ workingDir: workspaces.workingDir, status: workspaces.status })
      .from(workspaces).where(eq(workspaces.id, workspaceId)).then((r) => r[0]),
    db.select({ worktreePath: repos.worktreePath })
      .from(repos).where(and(eq(repos.workspaceId, workspaceId), eq(repos.isLeading, true))).then((r) => r[0]),
  ]);
}

describe("workspace git-state mirror (#226)", () => {
  it("clearWorkspaceWorkingDir clears the column AND the leading row", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seed(db);

    await clearWorkspaceWorkingDir(workspaceId, new Date().toISOString(), db);

    const [ws, row] = await readBoth(db, workspaceId);
    expect(ws.workingDir).toBeNull();
    expect(row.worktreePath).toBeNull();
  });

  it("closing a workspace leaves NO leading row pointing at the torn-down worktree", async () => {
    // The bug this epic would otherwise have shipped: status went to closed and the column was
    // cleared, while the row kept the path.
    const { db } = createTestDb();
    const { workspaceId } = await seed(db);
    const now = new Date().toISOString();

    await updateWorkspaceClosed(workspaceId, { status: "closed", workingDir: null, closedAt: now, updatedAt: now }, db);

    const [ws, row] = await readBoth(db, workspaceId);
    expect(ws.status).toBe("closed");
    expect(ws.workingDir).toBeNull();
    expect(row.worktreePath).toBeNull();
  });

  it("setWorkspaceWorkingDir writes both sides on a SET, not only on a clear", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seed(db);

    await setWorkspaceWorkingDir(db, workspaceId, "/repo/.worktrees/moved");

    const [ws, row] = await readBoth(db, workspaceId);
    expect(ws.workingDir).toBe("/repo/.worktrees/moved");
    expect(row.worktreePath).toBe("/repo/.worktrees/moved");
  });

  it("is a silent no-op for a workspace with no leading row — read-repair backfills it later", async () => {
    // A workspace created before migration 0110. A close must not fail because the row is
    // missing; `leadingRef` inserts it on the next read.
    const { db } = createTestDb();
    const { workspaceId } = await seed(db, { withLeadingRow: false });

    await expect(clearWorkspaceWorkingDir(workspaceId, new Date().toISOString(), db)).resolves.toBeUndefined();

    const [ws] = await readBoth(db, workspaceId);
    expect(ws.workingDir).toBeNull();
  });

  it("mirrors only the fields present in the patch, leaving the others alone", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seed(db);

    await mirrorWorkspaceGitStateToLeadingRepo(db, workspaceId, { mergedHeadSha: "abc123" });

    const [row] = await db.select().from(repos)
      .where(and(eq(repos.workspaceId, workspaceId), eq(repos.isLeading, true)));
    expect(row.mergedHeadSha).toBe("abc123");
    expect(row.worktreePath).toBe(WORKTREE);
    expect(row.branch).toBe("feature/ak-226");
  });

  it("an empty patch touches nothing", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seed(db);

    await mirrorWorkspaceGitStateToLeadingRepo(db, workspaceId, {});

    const [, row] = await readBoth(db, workspaceId);
    expect(row.worktreePath).toBe(WORKTREE);
  });

  it("never touches a SIBLING repo row", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seed(db);
    await db.insert(repos).values({
      id: randomUUID(), workspaceId, path: "/sibling", name: "sibling", defaultBranch: "main",
      isLeading: false, worktreePath: "/sibling/.worktrees/ws", branch: "feature/ak-226",
      createdAt: new Date().toISOString(),
    });

    await clearWorkspaceWorkingDir(workspaceId, new Date().toISOString(), db);

    const [sibling] = await db.select({ worktreePath: repos.worktreePath }).from(repos)
      .where(and(eq(repos.workspaceId, workspaceId), eq(repos.isLeading, false)));
    expect(sibling.worktreePath).toBe("/sibling/.worktrees/ws");
  });
});
