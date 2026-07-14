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

import { abortStaleMerges, pruneStaleWorktrees, shouldKillOrphanedServerProcess } from "../startup/startup-tasks.js";
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
