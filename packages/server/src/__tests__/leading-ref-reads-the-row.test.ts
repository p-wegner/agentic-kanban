// @covers workspaces.multiRepo.leadingRef [state-transition,regression-guard]
/**
 * `leadingRef` reads the physical `is_leading` repos row (#226, stage 4's source flip).
 *
 * Stage 2 built the row, dual-wrote it and read-repaired it, but deliberately kept the
 * SYNTHESIS from the workspace mirror columns authoritative. Flipping that is what turns
 * "repoint ~109 direct column reads" into "delete the fallbacks": every consumer of
 * `getAllWorkspaceRepos` — the merge path, the reconcilers, rebase, merge-status — moves onto
 * the row in one change.
 *
 * The first test is the one that matters, and it is written so it CANNOT pass by accident: it
 * seeds a row that DISAGREES with the columns. Before the flip that test failed, because the
 * read-repair converged the row back to the columns before anything read it — the row was
 * structurally unable to disagree, which is why this had to be more than a one-line change.
 */
import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { issues, projectStatuses, projects, repos, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { getAllWorkspaceRepos } from "../services/workspace-all-repos.js";
import type { Database } from "../db/index.js";

type Db = ReturnType<typeof createTestDb>["db"];

const COLUMNS = {
  branch: "feature/from-the-mirror-column",
  workingDir: "/repo/.worktrees/mirror",
  baseBranch: "mirror-base",
  baseCommitSha: "mirrorsha1111111",
  mergedHeadSha: "mirrormerged1111",
};
const ROW = {
  branch: "feature/ak-226-from-the-row",
  worktreePath: "/repo/.worktrees/row",
  baseBranch: "master",
  baseCommitSha: "rowsha22222222",
  mergedHeadSha: "rowmerged222222",
};

async function seed(db: Db, row: "disagreeing" | "absent") {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/project-repo", repoName: "repo",
    defaultBranch: "project-default", createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({
    id: statusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now,
  });
  await db.insert(issues).values({
    id: issueId, issueNumber: 226, title: "Issue 226", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId, ...COLUMNS,
    isDirect: false, status: "idle", readyForMerge: false, provider: "claude",
    createdAt: now, updatedAt: now,
  });
  if (row === "disagreeing") {
    await db.insert(repos).values({
      id: randomUUID(), workspaceId, path: "/project-repo", defaultBranch: "project-default",
      isLeading: true, createdAt: now, ...ROW,
    });
  }
  return { workspaceId };
}

async function leading(db: Db, workspaceId: string) {
  const all = await getAllWorkspaceRepos(workspaceId, db as unknown as Database);
  const ref = all.find((r) => r.kind === "leading");
  expect(ref).toBeDefined();
  return ref!;
}

describe("leadingRef sources the leading repo row (#226)", () => {
  it("returns the ROW's git state, not the mirror columns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db } = createTestDb();
    const { workspaceId } = await seed(db, "disagreeing");

    const ref = await leading(db, workspaceId);

    expect(ref.branch).toBe(ROW.branch);
    expect(ref.worktreePath).toBe(ROW.worktreePath);
    expect(ref.baseBranch).toBe(ROW.baseBranch);
    expect(ref.baseCommitSha).toBe(ROW.baseCommitSha);
    expect(ref.mergedHeadSha).toBe(ROW.mergedHeadSha);
    warn.mockRestore();
  });

  it("REPORTS a divergence instead of overwriting the row", async () => {
    // Stage 2 converged row -> columns here. That is what made the row unable to disagree.
    // Now a divergence means some write path skipped the mirror, and it should be findable.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db } = createTestDb();
    const { workspaceId } = await seed(db, "disagreeing");

    await leading(db, workspaceId);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("diverged from the workspace mirror columns"));
    const [row] = await db.select().from(repos).where(eq(repos.workspaceId, workspaceId));
    expect(row.branch).toBe(ROW.branch); // untouched
    warn.mockRestore();
  });

  it("keeps path and defaultBranch project-derived — they are not workspace git state", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db } = createTestDb();
    const { workspaceId } = await seed(db, "disagreeing");

    const ref = await leading(db, workspaceId);

    expect(ref.path).toBe("/project-repo");
    expect(ref.defaultBranch).toBe("project-default");
    warn.mockRestore();
  });

  it("falls back to the mirror columns when the workspace has no leading row", async () => {
    // Pre-migration-0110, or created in the stage-1->2 window. Must still work.
    const { db } = createTestDb();
    const { workspaceId } = await seed(db, "absent");

    const ref = await leading(db, workspaceId);

    expect(ref.branch).toBe(COLUMNS.branch);
    expect(ref.worktreePath).toBe(COLUMNS.workingDir);
    expect(ref.baseBranch).toBe(COLUMNS.baseBranch);
    expect(ref.baseCommitSha).toBe(COLUMNS.baseCommitSha);
    expect(ref.mergedHeadSha).toBe(COLUMNS.mergedHeadSha);
  });

  it("read-repairs the missing row on the SAME read, so the next one is row-sourced", async () => {
    // This is what makes the flip safe: the fallback is not a permanent parallel source, it is
    // the thing that populates the row.
    const { db } = createTestDb();
    const { workspaceId } = await seed(db, "absent");

    await leading(db, workspaceId);

    const rows = await db.select().from(repos).where(eq(repos.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
    expect(rows[0].isLeading).toBe(true);
    expect(rows[0].branch).toBe(COLUMNS.branch);
    expect(rows[0].worktreePath).toBe(COLUMNS.workingDir);
  });

  it("does not confuse a SIBLING row for the leading one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db } = createTestDb();
    const { workspaceId } = await seed(db, "disagreeing");
    await db.insert(repos).values({
      id: randomUUID(), workspaceId, path: "/sibling", name: "sibling", defaultBranch: "main",
      isLeading: false, createdAt: new Date().toISOString(),
      branch: "feature/sibling", worktreePath: "/sibling/.worktrees/ws", baseBranch: "main",
    });

    const all = await getAllWorkspaceRepos(workspaceId, db as unknown as Database);

    expect(all).toHaveLength(2);
    expect(all[0].kind).toBe("leading");
    expect(all[0].branch).toBe(ROW.branch);
    expect(all[1].kind).toBe("sibling");
    expect(all[1].branch).toBe("feature/sibling");
    warn.mockRestore();
  });
});
