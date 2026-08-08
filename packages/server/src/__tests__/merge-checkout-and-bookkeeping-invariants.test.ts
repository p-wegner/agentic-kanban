/**
 * #350 — after a merge reports success the MAIN checkout must not be left undoing it.
 *
 * Observed live on a pm-pipeline run and SILENT: the merge commit was correct and the tree
 * eventually settled, so the only evidence was a planner that could not see the artifacts it
 * had just merged, which read from the outside as "the board is stuck after approval".
 *
 * The load-bearing property of the #350 test is that the assertion is SYNCHRONOUS — inside the
 * merge path, before success is reported. The window it guards is ~32 seconds; a check that runs
 * asynchronously or a moment later finds a clean tree and always passes, which is exactly why
 * #296's retry hardening looked like it worked while the bug survived.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/index.js", async () => {
  const { createTestDb } = await import("./helpers/test-db.js");
  const schemaMod = await import("@agentic-kanban/shared/schema");
  const { db } = createTestDb();
  return {
    db,
    writeDb: db,
    rawClient: undefined,
    rawWriteClient: undefined,
    schema: schemaMod,
    withDbRetry: <T>(fn: () => Promise<T>) => fn(),
    withTransaction: <T>(database: { transaction: (fn: unknown) => Promise<T> }, fn: unknown) =>
      database.transaction(fn),
  };
});

vi.mock("../startup/done-unmerged-invariant-scanner.js", () => ({
  runDoneUnmergedScannerNow: vi.fn(),
}));

// The two shared-git primitives the #350 assertion is built from. Mocked so the test can put the
// checkout into the corrupt state without needing a real interrupted merge.
const gitMocks = vi.hoisted(() => ({
  getDeletedPathsVsHead: vi.fn(async () => [] as string[]),
  applyDeferredWorkingTreeSync: vi.fn(async () => {}),
  extractPendingWorkingTreeSync: vi.fn(() => null as string | null),
}));
vi.mock("@agentic-kanban/shared/lib/git-service", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ...gitMocks };
});

import { runMergeCore } from "../services/merge-executor.service.js";
import { activeMerges } from "../services/workspace-internals.js";
import { makeTempRepo } from "./helpers/temp-repo.js";

const REPO_PATH = makeTempRepo();

function stubGitService(overrides: Record<string, unknown> = {}) {
  return {
    mergeBranch: vi.fn(async () => "Merge made by the 'ort' strategy."),
    checkBranchTipIsAncestor: vi.fn(async () => ({ isAncestor: true as const, branchSha: "abc", baseSha: "def" })),
    revParse: vi.fn(async () => "merge-commit-sha"),
    getUncommittedTrackedChanges: vi.fn(async () => [] as string[]),
    removeWorktree: vi.fn(async () => {}),
    deleteBranch: vi.fn(async () => {}),
    syncBranchToHead: vi.fn(async () => false),
    autoRenumberMigrations: vi.fn(async () => ({ renumbered: false, renames: [] })),
    countUniqueCommits: vi.fn(async () => 1),
    detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
    getCurrentBranch: vi.fn(async () => "master"),
    getChangedFilesBetween: vi.fn(async () => [] as string[]),
    ...overrides,
  };
}

function coreArgs(gitService: ReturnType<typeof stubGitService>, deferWorkingTreeSync: boolean) {
  return {
    repoPath: REPO_PATH,
    branch: "feature/ak-350-test",
    targetBranch: "master",
    gitService: gitService as never,
    createBackup: async () => {},
    deferWorkingTreeSync,
    makeAncestryError: (b: string, t: string) => new Error(`ancestry ${b} ${t}`),
  };
}

beforeEach(() => {
  activeMerges.clear();
  gitMocks.getDeletedPathsVsHead.mockReset().mockResolvedValue([]);
  gitMocks.applyDeferredWorkingTreeSync.mockReset().mockResolvedValue(undefined);
  gitMocks.extractPendingWorkingTreeSync.mockReset().mockReturnValue(null);
});

describe("#350: the merge path asserts the main checkout reflects the merge, synchronously", () => {
  it("repairs a checkout left with the merged paths deleted, and then reports success", async () => {
    // Corrupt on the first probe, clean after the repair sync — the normal recoverable case.
    gitMocks.getDeletedPathsVsHead
      .mockResolvedValueOnce(["docs/pm-pipeline/steps/step-4/status.md", "docs/pm-pipeline/steps/step-4/user_stories.md"])
      .mockResolvedValueOnce([]);

    const result = await runMergeCore(coreArgs(stubGitService(), false));

    expect(gitMocks.applyDeferredWorkingTreeSync).toHaveBeenCalledWith(REPO_PATH, "merge-commit-sha");
    expect(result.mergeCommitSha).toBe("merge-commit-sha");
  });

  it("REFUSES to report success while the checkout still contradicts HEAD", async () => {
    gitMocks.getDeletedPathsVsHead.mockResolvedValue([
      "docs/pm-pipeline/steps/step-4/status.md",
      "docs/pm-pipeline/steps/step-4/user_stories.md",
    ]);

    await expect(runMergeCore(coreArgs(stubGitService(), false)))
      .rejects.toThrow(/Post-merge checkout invariant violated \(#350\)/);
  });

  it("does not assert when the caller explicitly owns the sync window (deferred path)", async () => {
    gitMocks.extractPendingWorkingTreeSync.mockReturnValue("pending-sha");
    gitMocks.getDeletedPathsVsHead.mockResolvedValue(["packages/server/src/x.ts"]);

    const result = await runMergeCore(coreArgs(stubGitService(), true));

    expect(result.pendingWorkingTreeSyncSha).toBe("pending-sha");
    // The interactive route deliberately defers the reset (#686); asserting there would fail
    // every such merge on a state the caller has promised to fix moments later.
    expect(gitMocks.getDeletedPathsVsHead).not.toHaveBeenCalled();
  });
});
