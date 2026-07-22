// @covers workspaces.multiRepo.mergePreflight
//
// Merge pre-flight multi-repo awareness (review finding #3): resolveMergeState used to
// judge ONLY the leading repo, so a sibling-only ticket (leading branch = fresh 0-commit
// cut) short-circuited to 'clean-ancestor' forever ("Merge skipped as a false-positive
// guard") and could never land its sibling work — or, in the 'reconcile' variant, got
// marked Done with the sibling commits unmerged. With `database` in the deps, the
// ancestor short-circuits now verify that NO sibling repo still has unmerged commits
// and return 'proceed' otherwise, routing the workspace through the full multi-repo
// merge pipeline. Fake git + real test DB (repos rows).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { projects, workspaces, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { insertWorkspaceRepo } from "../repositories/repo.repository.js";
import { setWorkspaceRepoMergedSha } from "../repositories/repo.repository.js";
import { listWorkspaceRepos } from "../repositories/repo.repository.js";
import {
  resolveMergeState,
  listPendingSiblingMerges,
  checkPendingSiblingMergeGuards,
  type GitService,
} from "../services/workspace-internals.js";
import type { Database } from "../db/index.js";

const SIBLING_PATH = "/sibling-repo";
const LEAD_PATH = "/lead";

function makeWorkspace(id: string, overrides: Partial<typeof workspaces.$inferSelect> = {}): typeof workspaces.$inferSelect {
  return {
    id,
    issueId: randomUUID(),
    branch: "feature/mrp",
    workingDir: null,
    baseBranch: "main",
    isDirect: false,
    status: "idle",
    readyForMerge: true,
    mergedAt: null,
    closedAt: null,
    baseCommitSha: null,
    provider: "claude",
    ...overrides,
  } as typeof workspaces.$inferSelect;
}

/**
 * Fake git: the leading branch is an ancestor of base (clean or already-landed) and
 * sibling probes dispatch on repo path. `siblingAhead` controls how many commits the
 * sibling branch is ahead of its base; `leadUnique` the leading branch's unique commits.
 */
function makeGit(opts: { leadUnique?: number; siblingAhead?: number; siblingBranchGone?: boolean } = {}) {
  const leadUnique = opts.leadUnique ?? 0;
  const siblingAhead = opts.siblingAhead ?? 0;
  // Distinct SHAs when the leading branch has landed commits; equal for a fresh cut.
  const branchSha = leadUnique > 0 ? "sha-branch" : "sha-base";
  return {
    checkBranchTipIsAncestor: vi.fn(async () => ({ isAncestor: true, branchSha, baseSha: "sha-base" })),
    countUniqueCommits: vi.fn(async (repoPath: string) => (repoPath === SIBLING_PATH ? siblingAhead : leadUnique)),
    getUncommittedTrackedChanges: vi.fn(async () => [] as string[]),
    revParse: vi.fn(async (repoPath: string, ref: string) => {
      if (opts.siblingBranchGone && repoPath === SIBLING_PATH && ref === "feature/mrp") {
        throw new Error(`fatal: ambiguous argument '${ref}'`);
      }
      return "resolved-sha";
    }),
    getCurrentBranch: vi.fn(async () => "main"),
    detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] as string[] })),
    detectConflictsByBranch: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] as string[] })),
  };
}

let db: TestDb;
let workspaceId: string;
let projectId: string;

beforeEach(async () => {
  ({ db } = createTestDb());
  projectId = randomUUID();
  await db.insert(projects).values({ id: projectId, name: "p", repoPath: LEAD_PATH, repoName: "lead", defaultBranch: "main" });
  const statusId = randomUUID();
  await db.insert(projectStatuses).values({ id: statusId, projectId, name: "Todo", sortOrder: 0 });
  const issueId = randomUUID();
  await db.insert(issues).values({ id: issueId, projectId, statusId, title: "t", issueNumber: 3 });
  workspaceId = randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, issueId, branch: "feature/mrp" });
});

async function insertSibling(opts: { mergedHeadSha?: string } = {}): Promise<string> {
  await insertWorkspaceRepo({
    workspaceId,
    projectId,
    path: SIBLING_PATH,
    name: "sibling",
    worktreePath: `${SIBLING_PATH}/.worktrees/mrp`,
    branch: "feature/mrp",
    baseBranch: "main",
  }, db);
  const [row] = await listWorkspaceRepos(workspaceId, db);
  if (opts.mergedHeadSha) await setWorkspaceRepoMergedSha(row.id, opts.mergedHeadSha, db);
  return row.id;
}

describe("resolveMergeState — multi-repo awareness (sibling-only work must proceed)", () => {
  it("single-repo workspace with database in deps: clean-ancestor short-circuit unchanged", async () => {
    const ws = makeWorkspace(workspaceId);
    const git = makeGit({ leadUnique: 0 });
    const result = await resolveMergeState(ws, LEAD_PATH, "main", {
      gitService: git as unknown as GitService,
      database: db as unknown as Database,
    });
    expect(result.kind).toBe("clean-ancestor");
  });

  it("returns proceed instead of clean-ancestor when a sibling repo has unmerged commits", async () => {
    await insertSibling();
    const ws = makeWorkspace(workspaceId);
    const git = makeGit({ leadUnique: 0, siblingAhead: 2 });
    const result = await resolveMergeState(ws, LEAD_PATH, "main", {
      gitService: git as unknown as GitService,
      database: db as unknown as Database,
    });
    expect(result.kind).toBe("proceed");
  });

  it("returns proceed instead of reconcile (Done-without-sibling-merge variant) when a sibling has unmerged commits", async () => {
    await insertSibling();
    const ws = makeWorkspace(workspaceId);
    const git = makeGit({ leadUnique: 1, siblingAhead: 1 });
    const result = await resolveMergeState(ws, LEAD_PATH, "main", {
      gitService: git as unknown as GitService,
      database: db as unknown as Database,
    });
    expect(result.kind).toBe("proceed");
  });

  it("still reconciles when the sibling merge already landed (mergedHeadSha stamped)", async () => {
    await insertSibling({ mergedHeadSha: "landed-sha" });
    const ws = makeWorkspace(workspaceId);
    const git = makeGit({ leadUnique: 1, siblingAhead: 5 /* would be pending if unstamped */ });
    const result = await resolveMergeState(ws, LEAD_PATH, "main", {
      gitService: git as unknown as GitService,
      database: db as unknown as Database,
    });
    expect(result.kind).toBe("reconcile");
  });

  it("still short-circuits to clean-ancestor when the sibling branch is gone (already cleaned)", async () => {
    await insertSibling();
    const ws = makeWorkspace(workspaceId);
    const git = makeGit({ leadUnique: 0, siblingAhead: 3, siblingBranchGone: true });
    const result = await resolveMergeState(ws, LEAD_PATH, "main", {
      gitService: git as unknown as GitService,
      database: db as unknown as Database,
    });
    expect(result.kind).toBe("clean-ancestor");
  });

  it("still short-circuits to clean-ancestor when the sibling is 0 commits ahead", async () => {
    await insertSibling();
    const ws = makeWorkspace(workspaceId);
    const git = makeGit({ leadUnique: 0, siblingAhead: 0 });
    const result = await resolveMergeState(ws, LEAD_PATH, "main", {
      gitService: git as unknown as GitService,
      database: db as unknown as Database,
    });
    expect(result.kind).toBe("clean-ancestor");
  });

  it("back-compat: without database in deps the legacy leading-only resolution applies", async () => {
    await insertSibling();
    const ws = makeWorkspace(workspaceId);
    const git = makeGit({ leadUnique: 1, siblingAhead: 1 });
    const result = await resolveMergeState(ws, LEAD_PATH, "main", { gitService: git as unknown as GitService });
    expect(result.kind).toBe("reconcile");
  });
});

describe("listPendingSiblingMerges / checkPendingSiblingMergeGuards", () => {
  it("lists only unstamped, existing, ahead-of-base sibling rows", async () => {
    await insertSibling();
    const git = makeGit({ siblingAhead: 2 });
    const pending = await listPendingSiblingMerges(git as unknown as GitService, db as unknown as Database, workspaceId);
    expect(pending).toHaveLength(1);
    expect(pending[0].repo.path).toBe(SIBLING_PATH);
    expect(pending[0].uniqueCommits).toBe(2);
  });

  it("guards report a dirty sibling main checkout", async () => {
    await insertSibling();
    const git = makeGit({ siblingAhead: 2 });
    git.getUncommittedTrackedChanges = vi.fn(async () => ["file.ts"]);
    const pending = await listPendingSiblingMerges(git as unknown as GitService, db as unknown as Database, workspaceId);
    const failures = await checkPendingSiblingMergeGuards(git as unknown as GitService, pending);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/uncommitted/i);
  });

  it("guards pass for a clean, conflict-free pending sibling", async () => {
    await insertSibling();
    const git = makeGit({ siblingAhead: 1 });
    const pending = await listPendingSiblingMerges(git as unknown as GitService, db as unknown as Database, workspaceId);
    const failures = await checkPendingSiblingMergeGuards(git as unknown as GitService, pending);
    expect(failures).toEqual([]);
  });
});
