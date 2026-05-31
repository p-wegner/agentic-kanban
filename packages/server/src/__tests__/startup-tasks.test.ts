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

import { abortStaleMerges, shouldKillOrphanedServerProcess } from "../startup/startup-tasks.js";
import { db } from "../db/index.js";
import * as gitService from "../services/git.service.js";

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
