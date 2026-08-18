// @covers workspaces.services.checkAlreadyMerged
//
// #648 item 1. `checkAlreadyMerged` is the idempotency guard in front of every
// close-without-merging path: `reconcile-as-done`, the merge endpoint's already-merged
// short-circuit, the merge queue, the reconciler agent. It decides "this branch is
// already on the base, so close it instead of merging again". A false POSITIVE closes a
// workspace whose work never landed and force-deletes its branch and worktrees — the
// silent-data-loss shape.
//
// Its only test, `workspace-already-merged.test.ts`, is EXCLUDED from `test:mine` for
// #173 load-flakiness (it drives the full merge service against real repos), so the
// pre-merge gate has never run one assertion about this guard. This is the fast twin:
// every REFUSAL path plus the two ways to a yes, against a fake git service and an
// in-memory DB — no real repo, so nothing here can flake on Windows file locking.
// It does not replace the excluded file, which still covers the end-to-end merge paths.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { projects, workspaces, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import { checkAlreadyMerged } from "../services/workspace-already-merged.service.js";

type TestDb = ReturnType<typeof createTestDb>["db"];

/** A git service that reports "branch is landed and empty-of-unique-work" unless overridden. */
function makeGit(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getDiff: vi.fn(async () => ""),
    getDiffFromRepo: vi.fn(async () => ""),
    checkBranchTipIsAncestor: vi.fn(async () => ({ isAncestor: true, branchSha: "sha-branch", baseSha: "sha-base" })),
    countUniqueCommits: vi.fn(async () => 1),
    revParse: vi.fn(async () => "sha-base\n"),
    listWorktrees: vi.fn(async () => []),
    getUncommittedTrackedChanges: vi.fn(async () => []),
    ...overrides,
  } as never;
}

async function seed(db: TestDb, opts: { isDirect?: boolean; branch?: string | null; workingDir?: string | null } = {}) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const statusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId, name: "Test", repoPath: "/repo", repoName: "repo", defaultBranch: "master",
    createdAt: now, updatedAt: now,
  });
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "Todo", sortOrder: 0, createdAt: now });
  await db.insert(issues).values({
    id: issueId, issueNumber: 648, title: "Already merged", priority: "medium", sortOrder: 0,
    statusId, projectId, createdAt: now, updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId, issueId,
    branch: opts.branch === undefined ? "feature/ak-648-guard" : opts.branch,
    workingDir: opts.workingDir === undefined ? "/repo/.worktrees/ak-648" : opts.workingDir,
    baseBranch: "master", isDirect: opts.isDirect ?? false,
    status: "idle", provider: "claude", createdAt: now, updatedAt: now,
  });
  return { workspaceId, issueId, projectId };
}

describe("checkAlreadyMerged — refusals (#648)", () => {
  let db: TestDb;
  beforeEach(() => { ({ db } = createTestDb()); });

  it("refuses while the branch still has a diff against the base", async () => {
    const { workspaceId } = await seed(db);
    const result = await checkAlreadyMerged(workspaceId, {
      database: db, gitService: makeGit({ getDiff: vi.fn(async () => "diff --git a/x b/x\n") }),
    });

    expect(result.isAlreadyMerged).toBe(false);
    expect(result.reason).toContain("still has a diff");
  });

  it("falls back to a repo-level diff when the worktree is gone, and still refuses on a real diff", async () => {
    // A vanished worktree must not read as "no diff" — that is a false positive on the
    // exact workspace most likely to have been abandoned mid-flight.
    const { workspaceId } = await seed(db);
    const gitService = makeGit({
      getDiff: vi.fn(async () => { throw new Error("not a git repository"); }),
      getDiffFromRepo: vi.fn(async () => "diff --git a/x b/x\n"),
    });

    const result = await checkAlreadyMerged(workspaceId, { database: db, gitService });

    expect(result.isAlreadyMerged).toBe(false);
    expect(result.reason).toContain("still has a diff");
  });

  it("refuses when the branch tip is not reachable from the base", async () => {
    const { workspaceId } = await seed(db);
    const result = await checkAlreadyMerged(workspaceId, {
      database: db,
      gitService: makeGit({
        checkBranchTipIsAncestor: vi.fn(async () => ({ isAncestor: false, branchSha: "sha-branch", baseSha: "sha-base" })),
      }),
    });

    expect(result.isAlreadyMerged).toBe(false);
    expect(result.reason).toContain("not reachable");
  });

  it("refuses when the branch ref cannot be resolved at all", async () => {
    const { workspaceId } = await seed(db);
    const result = await checkAlreadyMerged(workspaceId, {
      database: db,
      gitService: makeGit({
        checkBranchTipIsAncestor: vi.fn(async () => ({ isAncestor: false, branchSha: null, baseSha: null, reason: "branch-not-found" })),
      }),
    });

    expect(result.isAlreadyMerged).toBe(false);
    expect(result.reason).toContain("Branch ref not found");
  });

  it("names the base branch when it is the unresolvable one", async () => {
    const { workspaceId } = await seed(db);
    const result = await checkAlreadyMerged(workspaceId, {
      database: db,
      gitService: makeGit({
        checkBranchTipIsAncestor: vi.fn(async () => ({ isAncestor: false, branchSha: null, baseSha: null, reason: "base-not-found" })),
      }),
    });

    expect(result.reason).toContain("Could not resolve base branch master");
  });

  it("refuses an EMPTY branch rather than closing a workspace that never committed anything", async () => {
    // 0 unique commits + no sibling that landed = nothing was ever done here. Saying
    // "already merged" would close the issue as Done and delete the branch.
    const { workspaceId } = await seed(db);
    const result = await checkAlreadyMerged(workspaceId, {
      database: db, gitService: makeGit({ countUniqueCommits: vi.fn(async () => 0) }),
    });

    expect(result.isAlreadyMerged).toBe(false);
    expect(result.reason).toContain("no unique commits");
    // The refusal has to name its own override, or the operator's only visible option
    // is to force the workspace closed some other way.
    expect(result.reason).toContain("adoptMainCheckout=true");
  });

  it("rejects a direct workspace and a branchless one with a clear error, not a verdict", async () => {
    const direct = await seed(db, { isDirect: true });
    await expect(checkAlreadyMerged(direct.workspaceId, { database: db, gitService: makeGit() }))
      .rejects.toThrow(/direct workspaces/);

    // `workspaces.branch` is NOT NULL in the schema, so "no branch" can only ever be the
    // empty string — the guard's falsy check is what catches that legacy shape.
    const branchless = await seed(db, { branch: "" });
    await expect(checkAlreadyMerged(branchless.workspaceId, { database: db, gitService: makeGit() }))
      .rejects.toThrow(/no branch/);

    await expect(checkAlreadyMerged(randomUUID(), { database: db, gitService: makeGit() }))
      .rejects.toThrow(/not found/i);
  });
});

describe("checkAlreadyMerged — the two ways to a yes (#648)", () => {
  let db: TestDb;
  beforeEach(() => { ({ db } = createTestDb()); });

  it("confirms a landed branch that contributed real commits", async () => {
    const { workspaceId } = await seed(db);
    const result = await checkAlreadyMerged(workspaceId, { database: db, gitService: makeGit() });

    expect(result.isAlreadyMerged).toBe(true);
    expect(result.branch).toBe("feature/ak-648-guard");
    expect(result.baseBranch).toBe("master");
    expect(result.issueNumber).toBe(648);
    expect(result.mergeCommitSha).toBe("sha-base");
    expect(result.adopted).toBeUndefined();
  });

  it("adopts an empty branch ONLY when the operator asserts it, and flags the result as adopted", async () => {
    // #218: `adopted` is the audit trail separating a git-verified merge from an
    // operator's assertion that the work landed out-of-band. Losing that flag makes the
    // two indistinguishable afterwards.
    const { workspaceId } = await seed(db);
    const result = await checkAlreadyMerged(workspaceId, {
      database: db, gitService: makeGit({ countUniqueCommits: vi.fn(async () => 0) }), adoptMainCheckout: true,
    });

    expect(result.isAlreadyMerged).toBe(true);
    expect(result.adopted).toBe(true);
  });

  it("survives a git service that cannot count commits — it degrades, it does not throw", async () => {
    const { workspaceId } = await seed(db);
    const result = await checkAlreadyMerged(workspaceId, {
      database: db,
      gitService: makeGit({ countUniqueCommits: vi.fn(async () => { throw new Error("bad revision"); }) }),
    });

    // Uncountable is treated as zero, which lands on the conservative REFUSAL above.
    expect(result.isAlreadyMerged).toBe(false);
  });

  it("still confirms when revParse cannot name the merge commit", async () => {
    const { workspaceId } = await seed(db);
    const result = await checkAlreadyMerged(workspaceId, {
      database: db, gitService: makeGit({ revParse: vi.fn(async () => { throw new Error("no ref"); }) }),
    });

    expect(result.isAlreadyMerged).toBe(true);
    expect(result.mergeCommitSha).toBeNull();
  });
});
