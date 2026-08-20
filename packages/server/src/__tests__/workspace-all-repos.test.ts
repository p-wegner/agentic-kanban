// @covers workspaces.multiRepo.uniformRepoView
//
// #168: the leading repo lives on the `workspaces` row and siblings on `repos` rows, which
// forced every merge/reconcile/status routine to be written twice (a leading branch + a sibling
// loop) and drift. getAllWorkspaceRepos collapses both into ONE ordered list — leading as row 0,
// synthesized from the workspace+project rows — and stampRepoMergedHeadSha routes a write back to
// the correct storage. These tests lock that seam so a future edit can't silently reintroduce the
// asymmetry. Pure DB (no git).

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { projects, workspaces, issues, projectStatuses, repos } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { insertWorkspaceRepo } from "../repositories/repo.repository.js";
import { getAllWorkspaceRepos, stampRepoMergedHeadSha } from "../services/workspace-all-repos.js";
import type { Database } from "../db/index.js";

let db: TestDb;

async function seed(opts: {
  workspaceBaseBranch: string | null;
  defaultBranch: string | null;
  workingDir?: string | null;
  mergedHeadSha?: string | null;
  withSibling?: boolean;
}): Promise<{ projectId: string; workspaceId: string; siblingId?: string }> {
  const projectId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "p", repoPath: "C:/repo/lead", repoName: "lead", defaultBranch: opts.defaultBranch });
  const statusId = randomUUID();
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "Todo", sortOrder: 0 });
  const issueId = randomUUID();
  await db.insert(issues).values({ id: issueId, projectId, statusId, title: "t", issueNumber: 1 });
  const workspaceId = randomUUID();
  await db.insert(workspaces).values({
    id: workspaceId, issueId, branch: "feature/mrm", baseBranch: opts.workspaceBaseBranch,
    baseCommitSha: "cut-sha", workingDir: opts.workingDir ?? "C:/repo/.worktrees/feature_mrm",
    mergedHeadSha: opts.mergedHeadSha ?? null, status: "closed",
  });
  let siblingId: string | undefined;
  if (opts.withSibling) {
    await insertWorkspaceRepo({
      workspaceId, projectId, path: "C:/repo/sib", name: "sib",
      worktreePath: "C:/repo/.worktrees/sib/feature_mrm", branch: "feature/mrm", baseBranch: "main",
      baseCommitSha: "sib-cut",
    }, db as unknown as Database);
    const row = (await db.select().from(repos).where(eq(repos.workspaceId, workspaceId)))[0];
    siblingId = row.id;
  }
  return { projectId, workspaceId, siblingId };
}

beforeEach(() => {
  ({ db } = createTestDb());
});

describe("getAllWorkspaceRepos (#168 uniform repo view)", () => {
  it("returns the leading repo as row 0, synthesized from the workspace + project rows", async () => {
    const { workspaceId } = await seed({ workspaceBaseBranch: "main", defaultBranch: "main", mergedHeadSha: "lead-tip" });
    const all = await getAllWorkspaceRepos(workspaceId, db as unknown as Database);

    expect(all).toHaveLength(1); // single-repo workspace → leading only
    const leading = all[0];
    expect(leading.kind).toBe("leading");
    expect(leading.id).toBe(workspaceId); // leading's write target is the workspace row
    expect(leading.path).toBe("C:/repo/lead"); // projects.repoPath
    expect(leading.worktreePath).toBe("C:/repo/.worktrees/feature_mrm"); // workspaces.workingDir
    expect(leading.branch).toBe("feature/mrm");
    expect(leading.baseBranch).toBe("main");
    expect(leading.baseCommitSha).toBe("cut-sha");
    expect(leading.mergedHeadSha).toBe("lead-tip");
    expect(leading.name).toBeNull();
  });

  it("appends each sibling after the leading, from its repos row", async () => {
    const { workspaceId, siblingId } = await seed({ workspaceBaseBranch: "main", defaultBranch: "main", withSibling: true });
    const all = await getAllWorkspaceRepos(workspaceId, db as unknown as Database);

    expect(all.map((r) => r.kind)).toEqual(["leading", "sibling"]);
    const sib = all[1];
    expect(sib.id).toBe(siblingId); // sibling's write target is its repos row
    expect(sib.path).toBe("C:/repo/sib");
    expect(sib.name).toBe("sib");
    expect(sib.worktreePath).toBe("C:/repo/.worktrees/sib/feature_mrm");
    expect(sib.branch).toBe("feature/mrm");
    expect(sib.baseBranch).toBe("main");
  });

  it("falls back the leading baseBranch to the project default branch when the workspace baseBranch is empty", async () => {
    const { workspaceId } = await seed({ workspaceBaseBranch: null, defaultBranch: "develop" });
    const [leading] = await getAllWorkspaceRepos(workspaceId, db as unknown as Database);
    expect(leading.baseBranch).toBe("develop");
  });

  it("returns an empty list for a missing workspace", async () => {
    const all = await getAllWorkspaceRepos(randomUUID(), db as unknown as Database);
    expect(all).toEqual([]);
  });
});

describe("stampRepoMergedHeadSha (#168 write-back routing)", () => {
  it("routes a leading stamp to the workspace row", async () => {
    const { workspaceId } = await seed({ workspaceBaseBranch: "main", defaultBranch: "main" });
    const [leading] = await getAllWorkspaceRepos(workspaceId, db as unknown as Database);

    await stampRepoMergedHeadSha(leading, "aaa111", new Date().toISOString(), db as unknown as Database);

    const ws = (await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0];
    expect(ws.mergedHeadSha).toBe("aaa111");
  });

  it("routes a sibling stamp to its repos row (not the workspace row)", async () => {
    const { workspaceId, siblingId } = await seed({ workspaceBaseBranch: "main", defaultBranch: "main", withSibling: true });
    const all = await getAllWorkspaceRepos(workspaceId, db as unknown as Database);
    const sib = all.find((r) => r.kind === "sibling")!;

    await stampRepoMergedHeadSha(sib, "bbb222", new Date().toISOString(), db as unknown as Database);

    const sibRow = (await db.select().from(repos).where(eq(repos.id, siblingId!)))[0];
    expect(sibRow.mergedHeadSha).toBe("bbb222");
    // The workspace row (leading storage) is untouched by a sibling stamp.
    const ws = (await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0];
    expect(ws.mergedHeadSha).toBeFalsy();
  });
});
