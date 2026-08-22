import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock db before importing the module under test
vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
      })),
    })),
    insert: vi.fn(() => ({ onConflictDoUpdate: vi.fn(() => Promise.resolve()) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
  },
  rawClient: {},
}));

vi.mock("../services/git.service.js", () => ({
  isMergeInProgress: vi.fn(async () => false),
  abortMerge: vi.fn(async () => {}),
  removeWorktree: vi.fn(async () => {}),
}));

vi.mock("../db/manual-migrate.js", () => ({ applyMigrations: vi.fn(async () => {}) }));
vi.mock("../db/seed.js", () => ({ ensureBuiltinTags: vi.fn(async () => {}), ensureBuiltinSkills: vi.fn(async () => {}) }));
vi.mock("../services/project-registration.js", () => ({ deduplicateProjects: vi.fn(async () => {}) }));
vi.mock("../services/workspace-repos.service.js", () => ({ cleanupSiblingWorktrees: vi.fn(async () => {}) }));

import { abortStaleMerges, pruneStaleWorktrees, shouldKillOrphanedServerProcess, shouldSkipOrphanCleanup } from "../startup/startup-tasks.js";
import { db } from "../db/index.js";
import * as gitService from "../services/git.service.js";
import { cleanupSiblingWorktrees } from "../services/workspace-repos.service.js";

const mockDb = db as unknown as {
  select: ReturnType<typeof vi.fn>;
};
const mockGit = gitService as unknown as {
  isMergeInProgress: ReturnType<typeof vi.fn>;
  abortMerge: ReturnType<typeof vi.fn>;
};

describe("abortStaleMerges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when no projects exist", async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn(() => Promise.resolve([])),
    });

    await abortStaleMerges();

    expect(mockGit.isMergeInProgress).not.toHaveBeenCalled();
    expect(mockGit.abortMerge).not.toHaveBeenCalled();
  });

  it("does nothing when projects have no in-progress merge", async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn(() => Promise.resolve([{ repoPath: "/repo/a" }, { repoPath: "/repo/b" }])),
    });
    mockGit.isMergeInProgress.mockResolvedValue(false);

    await abortStaleMerges();

    expect(mockGit.isMergeInProgress).toHaveBeenCalledTimes(2);
    expect(mockGit.abortMerge).not.toHaveBeenCalled();
  });

  it("calls abortMerge for each repo that has MERGE_HEAD", async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn(() => Promise.resolve([{ repoPath: "/repo/a" }, { repoPath: "/repo/b" }])),
    });
    mockGit.isMergeInProgress
      .mockResolvedValueOnce(true)   // /repo/a has MERGE_HEAD
      .mockResolvedValueOnce(false); // /repo/b does not

    await abortStaleMerges();

    expect(mockGit.isMergeInProgress).toHaveBeenCalledWith("/repo/a");
    expect(mockGit.isMergeInProgress).toHaveBeenCalledWith("/repo/b");
    expect(mockGit.abortMerge).toHaveBeenCalledTimes(1);
    expect(mockGit.abortMerge).toHaveBeenCalledWith("/repo/a");
  });

  it("continues to next repo if abortMerge throws", async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn(() => Promise.resolve([{ repoPath: "/repo/a" }, { repoPath: "/repo/b" }])),
    });
    mockGit.isMergeInProgress.mockResolvedValue(true);
    mockGit.abortMerge
      .mockRejectedValueOnce(new Error("abort failed"))
      .mockResolvedValueOnce(undefined);

    await abortStaleMerges();

    // Should attempt abort for both repos even if the first fails
    expect(mockGit.abortMerge).toHaveBeenCalledTimes(2);
  });

  it("is non-fatal when db query throws", async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn(() => { throw new Error("db unavailable"); }),
    });

    // Should not throw
    await expect(abortStaleMerges()).resolves.toBeUndefined();
  });
});

describe("pruneStaleWorktrees", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prunes sibling worktrees with preserveUnmerged so unshipped sibling branches survive", async () => {
    // Query order inside pruneStaleWorktrees: closed workspaces -> issue -> project.
    mockDb.select
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve([
            { id: "ws-1", branch: "feature/x", workingDir: "C:/wt/x", issueId: "issue-1" },
          ])),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([{ projectId: "proj-1" }])) })),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([{ repoPath: "C:/repo" }])) })),
        })),
      });

    await pruneStaleWorktrees();

    const mockCleanup = vi.mocked(cleanupSiblingWorktrees);
    expect(mockCleanup).toHaveBeenCalledTimes(1);
    const [, workspaceId, , opts] = mockCleanup.mock.calls[0];
    expect(workspaceId).toBe("ws-1");
    // This path never deletes the leading branch of a closed workspace, so an
    // unmerged sibling branch must be preserved too — not force-deleted at startup.
    expect(opts).toEqual({ preserveUnmerged: true });
  });

  /**
   * #735 — `pruneStaleWorktrees` was the third of #713's `TO CONVERT` sites: a raw
   * `removeWorktree` with no claim analysis at all. `status='closed'` on the row being swept
   * says nothing about whether ANOTHER workspace shares the directory, and co-residency
   * (#394) is supported — a shared-worktree fork child reuses its parent's workingDir. So a
   * boot that closed the parent recursive-deleted the live child's checkout.
   *
   * Query order in the guarded path: closed workspaces -> issue -> project -> the guard's
   * own unfiltered claim read.
   */
  function seedOneStaleWorkspace(claims: { id: string; status: string; workingDir: string }[]) {
    mockDb.select
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve([
            { id: "ws-1", branch: "feature/x", workingDir: "C:/wt/x", issueId: "issue-1" },
          ])),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([{ projectId: "proj-1" }])) })),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([{ repoPath: "C:/repo" }])) })),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve(claims)) })),
      });
  }

  it("removes the stale worktree when nothing live claims it", async () => {
    seedOneStaleWorkspace([{ id: "ws-1", status: "closed", workingDir: "C:/wt/x" }]);

    await pruneStaleWorktrees();

    expect(vi.mocked(gitService.removeWorktree)).toHaveBeenCalledWith("C:/repo", "C:/wt/x");
  });

  it("REFUSES to remove a worktree a co-resident LIVE workspace still shares", async () => {
    // The fork-child shape: a second, non-terminal row on the SAME workingDir.
    seedOneStaleWorkspace([
      { id: "ws-1", status: "closed", workingDir: "C:/wt/x" },
      { id: "ws-child", status: "active", workingDir: "C:/wt/x" },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await pruneStaleWorktrees();

    expect(vi.mocked(gitService.removeWorktree)).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).toContain("skipping removal");
    warn.mockRestore();
  });

  it("REFUSES when the claim read itself fails — a locked DB is not a green light", async () => {
    mockDb.select
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve([
            { id: "ws-1", branch: "feature/x", workingDir: "C:/wt/x", issueId: "issue-1" },
          ])),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([{ projectId: "proj-1" }])) })) })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([{ repoPath: "C:/repo" }])) })) })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({ where: vi.fn(() => { throw new Error("database is locked"); }) })),
      });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await pruneStaleWorktrees();

    expect(vi.mocked(gitService.removeWorktree)).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).toContain("refusing to remove worktree");
    warn.mockRestore();
  });

  it("does nothing when no closed workspace still has a workingDir", async () => {
    mockDb.select.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([{ id: "ws-2", branch: "b", workingDir: null, issueId: "i" }])),
      })),
    });

    await pruneStaleWorktrees();

    expect(vi.mocked(cleanupSiblingWorktrees)).not.toHaveBeenCalled();
  });
});

describe("shouldKillOrphanedServerProcess", () => {
  it("allows cleanup for a server process in the same main checkout", () => {
    expect(shouldKillOrphanedServerProcess({
      pid: 123,
      checkoutRoot: "C:\\andrena\\agentic-kanban\\packages\\server",
      commandLine: "node C:\\andrena\\agentic-kanban\\packages\\server\\node_modules\\tsx\\dist\\cli.mjs watch src/index.ts",
    })).toBe(true);
  });

  it("blocks a worktree startup from killing the main board checkout", () => {
    expect(shouldKillOrphanedServerProcess({
      pid: 123,
      checkoutRoot: "C:\\andrena\\.worktrees\\feature_ak-145-workflow-analytics-drilldown\\packages\\server",
      commandLine: "node C:\\andrena\\agentic-kanban\\packages\\server\\node_modules\\tsx\\dist\\cli.mjs watch src/index.ts",
    })).toBe(false);
  });

  it("blocks protected board pids even when the command line matches", () => {
    expect(shouldKillOrphanedServerProcess({
      pid: 123,
      protectedPids: new Set([123]),
      checkoutRoot: "C:\\andrena\\agentic-kanban\\packages\\server",
      commandLine: "node C:\\andrena\\agentic-kanban\\packages\\server\\node_modules\\tsx\\dist\\cli.mjs watch src/index.ts",
    })).toBe(false);
  });
});

describe("shouldSkipOrphanCleanup", () => {
  it("is off by default", () => {
    expect(shouldSkipOrphanCleanup({})).toBe(false);
  });

  it("opts a co-tenant server out of reaping its own checkout (#645)", () => {
    expect(shouldSkipOrphanCleanup({ KANBAN_SKIP_ORPHAN_CLEANUP: "1" })).toBe(true);
    expect(shouldSkipOrphanCleanup({ KANBAN_SKIP_ORPHAN_CLEANUP: "true" })).toBe(true);
  });
});
