// #222 stage 1 (#223): the leading repo gets a PHYSICAL `repos` row (`is_leading=1`,
// backfilled by migration 0110 for existing workspaces). Reads are NOT flipped yet —
// `leadingRef()` still synthesizes from the workspace columns — so the one invariant this
// stage must hold is: the new row is INVISIBLE to every "the workspace's siblings" query.
// Before the filters, the backfilled leading row would have been double-counted as a
// sibling (breaking single-repo fast paths, sibling prevalidation, and stranded scans).
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projectStatuses, projects, repos, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import {
  getLeadingRepoRow,
  insertLeadingWorkspaceRepo,
  listWorkspaceRepos,
} from "../repositories/repo.repository.js";
import { getAllWorkspaceRepos } from "../services/workspace-all-repos.js";
import { stampWorkspaceMergedAt } from "../repositories/workspace-merge-execution.repository.js";
import { clearWorkspaceWorkingDir } from "../repositories/workspace-crud.repository.js";
import type { Database } from "../db/index.js";

type Db = ReturnType<typeof createTestDb>["db"];

async function seedWorkspace(db: Db) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();
  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/main/repo", repoName: "repo",
    defaultBranch: "master", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: statusId, projectId, name: "In Progress", sortOrder: 1, isDefault: true, createdAt: now },
  ]);
  await db.insert(issues).values({
    id: issueId, issueNumber: 223, title: "Leading row", priority: "medium",
    sortOrder: 0, statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/ak-223", workingDir: "/main/repo/.worktrees/ak-223",
    baseBranch: "master", isDirect: false, status: "idle", readyForMerge: false,
    provider: "claude", createdAt: now, updatedAt: now,
  });
  return { projectId, issueId, workspaceId };
}

describe("physical leading-repo row (#222 stage 1)", () => {
  it("insertLeadingWorkspaceRepo stores an is_leading row retrievable via getLeadingRepoRow", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seedWorkspace(db);

    await insertLeadingWorkspaceRepo({
      workspaceId, path: "/main/repo", defaultBranch: "master",
      worktreePath: "/main/repo/.worktrees/ak-223", branch: "feature/ak-223", baseBranch: "master",
    }, db as unknown as Database);

    const row = await getLeadingRepoRow(workspaceId, db as unknown as Database);
    expect(row).toMatchObject({ workspaceId, path: "/main/repo", branch: "feature/ak-223", isLeading: true });

    // Idempotent: a second insert (create retried after a crash) is a no-op, not an error.
    await insertLeadingWorkspaceRepo({ workspaceId, path: "/main/repo" }, db as unknown as Database);
    const all = await db.select().from(repos);
    expect(all).toHaveLength(1);
  });

  it("the leading row is INVISIBLE to sibling queries and never double-counted by getAllWorkspaceRepos", async () => {
    const { db } = createTestDb();
    const { projectId, workspaceId } = await seedWorkspace(db);

    await insertLeadingWorkspaceRepo({
      workspaceId, path: "/main/repo", defaultBranch: "master",
      worktreePath: "/main/repo/.worktrees/ak-223", branch: "feature/ak-223", baseBranch: "master",
    }, db as unknown as Database);
    // One genuine sibling.
    await db.insert(repos).values({
      id: randomUUID(), workspaceId, projectId, path: "/sibling/repo", name: "sibling",
      worktreePath: "/sibling/repo/.worktrees/ak-223", branch: "feature/ak-223", baseBranch: "main",
    });

    const siblings = await listWorkspaceRepos(workspaceId, db as unknown as Database);
    expect(siblings).toHaveLength(1);
    expect(siblings[0].path).toBe("/sibling/repo");

    // The uniform view: exactly ONE leading (still synthesized in stage 1) + the sibling.
    const all = await getAllWorkspaceRepos(workspaceId, db as unknown as Database);
    expect(all).toHaveLength(2);
    expect(all[0].kind).toBe("leading");
    expect(all[1]).toMatchObject({ kind: "sibling", path: "/sibling/repo" });
  });

  it("merge-stamp and workingDir-clear dual-write onto the leading row (#224)", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seedWorkspace(db);
    await insertLeadingWorkspaceRepo({
      workspaceId, path: "/main/repo", worktreePath: "/main/repo/.worktrees/ak-223", branch: "feature/ak-223",
    }, db as unknown as Database);

    const now = new Date().toISOString();
    await stampWorkspaceMergedAt(workspaceId, now, "merged-sha-224", db as unknown as Database);
    let row = await getLeadingRepoRow(workspaceId, db as unknown as Database);
    expect(row?.mergedHeadSha).toBe("merged-sha-224");

    await clearWorkspaceWorkingDir(workspaceId, now, db as unknown as Database);
    row = await getLeadingRepoRow(workspaceId, db as unknown as Database);
    expect(row?.worktreePath).toBeNull();
  });

  it("leadingRef read-repair backfills a missing leading row and converges a diverged one (#224)", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seedWorkspace(db);

    // No row yet (workspace created in the stage-1→2 window): a read repairs it.
    await getAllWorkspaceRepos(workspaceId, db as unknown as Database);
    await vi.waitFor(async () => {
      const row = await getLeadingRepoRow(workspaceId, db as unknown as Database);
      expect(row).toMatchObject({ path: "/main/repo", branch: "feature/ak-223", isLeading: true });
    });

    // Diverge the row by hand; the next read converges it back to the workspace columns.
    const { repos: reposTable } = await import("@agentic-kanban/shared/schema");
    const { eq } = await import("drizzle-orm");
    await db.update(reposTable).set({ branch: "stale-branch" }).where(eq(reposTable.workspaceId, workspaceId));
    await getAllWorkspaceRepos(workspaceId, db as unknown as Database);
    await vi.waitFor(async () => {
      const row = await getLeadingRepoRow(workspaceId, db as unknown as Database);
      expect(row?.branch).toBe("feature/ak-223");
    });
  });

  it("a single-repo workspace with a backfilled leading row still takes the single-repo fast path", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seedWorkspace(db);
    await insertLeadingWorkspaceRepo({ workspaceId, path: "/main/repo" }, db as unknown as Database);

    expect(await listWorkspaceRepos(workspaceId, db as unknown as Database)).toHaveLength(0);
    const all = await getAllWorkspaceRepos(workspaceId, db as unknown as Database);
    expect(all).toHaveLength(1);
    expect(all[0].kind).toBe("leading");
  });
});
