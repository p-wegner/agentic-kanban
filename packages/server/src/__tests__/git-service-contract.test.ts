/**
 * Contract test: server git-service re-export surface vs @agentic-kanban/shared
 *
 * Stale-dist canary (2026-06-05): merging #549 caused a "... is not a function" 500
 * because the running shared dist didn't export checkBranchTipIsAncestor yet.
 * This test enumerates every git-service method the server layer calls and fails
 * fast at test-time if any is missing or not a function on the imported module.
 */
import { describe, it, expect } from "vitest";
import * as gitService from "../services/git.service.js";

/**
 * Every function the server routes/services/startup actually call on gitService.
 * Derived from all imports of git.service.js across packages/server/src/{services,startup}.
 * Covers both `gitService.X()` call-style and named imports like `import { X } from`.
 */
const REQUIRED_METHODS = [
  "abortMerge",
  "abortRebase",
  "autoRenumberMigrations",
  "checkBranchTipIsAncestor",
  "commitPaths",
  "createWorktree",
  "deleteBranch",
  "detectConflicts",
  "ensureOnBranch",
  "getChangedFileNames",
  "getChangedFilesBetween",
  "getCommitCountAhead",
  "getCommitSummariesBetween",
  "getCurrentBranch",
  "getDiff",
  "getDiffFromRepo",
  "getDiffShortstat",
  "getHeadCommitSha",
  "getLatestCommit",
  "getUncommittedTrackedChanges",
  "getWorkingTreeDiff",
  "isAncestor",
  "isMergeInProgress",
  "isRebaseInProgress",
  "listBranches",
  "listWorktrees",
  "mergeBranch",
  "mergeBaseIntoBranch",
  "prepareForReview",
  "pruneWorktrees",
  "rebaseOntoBase",
  "removeWorktree",
  "revParse",
  "syncBranchToHead",
] as const;

describe("git-service contract: server re-export surface", () => {
  it("exports every function the server depends on (stale-dist canary)", () => {
    const missing = REQUIRED_METHODS.filter(
      (name) => typeof (gitService as Record<string, unknown>)[name] !== "function"
    );
    expect(missing, `Missing git-service exports: ${missing.join(", ")}`).toEqual([]);
  });
});
