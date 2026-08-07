// @covers workspace.dto.leading-repo [state-transition,regression-guard]
/**
 * The client-facing workspace DTOs read git state from the LEADING REPO ROW (#225, stage 3
 * of the #222 epic).
 *
 * `branch` / `workingDir` / `baseBranch` were read straight off the `workspaces` mirror
 * columns, which is what stage 4 (#226) wants to drop. Nothing about the wire contract
 * changes here — the DTO fields keep their names, so every UI component that renders
 * `workspace.branch` is migrated by construction — but the SOURCE moves, which is the part
 * that has to be true before the columns can go.
 *
 * These tests are deliberately written so they cannot pass by accident: each seeds a leading
 * repo row that DISAGREES with the mirror columns, so reading the old source produces the
 * wrong answer rather than the same one. The fallback tests then prove a row-less workspace
 * (created before migration 0110, or one a dual-write missed) still projects correctly while
 * the columns are still there.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projectStatuses, projects, repos, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { getWorkspaceDetails } from "../repositories/workspace-reads.repository.js";
import { aggregateWorkspaceCountRows, fetchWorkspaceDetailRows } from "../repositories/workspace-summary.repository.js";

type Db = ReturnType<typeof createTestDb>["db"];

const MIRROR = {
  branch: "feature/stale-mirror-column",
  workingDir: "/repo/.worktrees/stale-mirror",
  baseBranch: "stale-base",
};
const LEADING = {
  branch: "feature/ak-225-from-the-row",
  worktreePath: "/repo/.worktrees/from-the-row",
  baseBranch: "master",
};

async function seed(db: Db, opts: { withLeadingRow: boolean }) {
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
    id: issueId, issueNumber: 225, title: "Issue 225", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, ...MIRROR,
    isDirect: false, status: "idle", readyForMerge: false, provider: "claude",
    createdAt: now, updatedAt: now,
  });
  if (opts.withLeadingRow) {
    await db.insert(repos).values({
      id: randomUUID(), workspaceId, path: "/repo", defaultBranch: "master",
      isLeading: true, createdAt: now, ...LEADING,
    });
    // A SIBLING row for the same workspace. If the join is not restricted to the leading
    // row, this multiplies the result and/or wins the coalesce — the exact mistake the
    // aliased join exists to prevent.
    await db.insert(repos).values({
      id: randomUUID(), workspaceId, path: "/sibling", name: "sibling", defaultBranch: "main",
      isLeading: false, createdAt: now,
      branch: "feature/sibling-branch", worktreePath: "/sibling/.worktrees/ws", baseBranch: "main",
    });
  }
  return { issueId, workspaceId };
}

describe("workspace DTOs source git state from the leading repo row (#225)", () => {
  it("getWorkspaceDetails returns the ROW's branch/workingDir/baseBranch, not the mirror columns", async () => {
    const { db } = createTestDb();
    const { workspaceId } = await seed(db, { withLeadingRow: true });

    const details = await getWorkspaceDetails(workspaceId, db);

    expect(details).not.toBeNull();
    expect(details!.branch).toBe(LEADING.branch);
    expect(details!.workingDir).toBe(LEADING.worktreePath);
    expect(details!.baseBranch).toBe(LEADING.baseBranch);
  });

  it("getWorkspaceDetails falls back to the mirror columns when there is no leading row", async () => {
    // A workspace created before migration 0110, or one a dual-write missed. The columns are
    // still there until stage 4, so it must still project — `leadingRef` read-repairs the row.
    const { db } = createTestDb();
    const { workspaceId } = await seed(db, { withLeadingRow: false });

    const details = await getWorkspaceDetails(workspaceId, db);

    expect(details!.branch).toBe(MIRROR.branch);
    expect(details!.workingDir).toBe(MIRROR.workingDir);
    expect(details!.baseBranch).toBe(MIRROR.baseBranch);
  });

  it("the board summary detail rows read the leading row too", async () => {
    const { db } = createTestDb();
    const { issueId } = await seed(db, { withLeadingRow: true });

    const rows = await fetchWorkspaceDetailRows([issueId], db);

    expect(rows).toHaveLength(1); // the sibling row must not multiply this
    expect(rows[0].branch).toBe(LEADING.branch);
    expect(rows[0].workingDir).toBe(LEADING.worktreePath);
    expect(rows[0].baseBranch).toBe(LEADING.baseBranch);
  });

  it("the board's branch aggregation reads the leading row, and the sibling does not split the count", async () => {
    const { db } = createTestDb();
    const { issueId } = await seed(db, { withLeadingRow: true });

    const rows = await aggregateWorkspaceCountRows([issueId], db);

    expect(rows).toHaveLength(1);
    expect(rows[0].branch).toBe(LEADING.branch);
    expect(rows[0].count).toBe(1);
  });

  it("summary rows fall back to the mirror columns with no leading row", async () => {
    const { db } = createTestDb();
    const { issueId } = await seed(db, { withLeadingRow: false });

    const [detail] = await fetchWorkspaceDetailRows([issueId], db);
    const [aggregate] = await aggregateWorkspaceCountRows([issueId], db);

    expect(detail.branch).toBe(MIRROR.branch);
    expect(detail.workingDir).toBe(MIRROR.workingDir);
    expect(aggregate.branch).toBe(MIRROR.branch);
  });
});
