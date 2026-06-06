import { describe, expect, it, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { validateOpenSpecChange } from "@agentic-kanban/shared/lib/openspec";
import { detectWorkspaceMergeConflicts } from "../services/workspace-merge-conflict.service.js";
import { runWorkspacePreMergeValidation } from "../services/workspace-merge-prevalidation.service.js";
import { executeWorkspaceMerge } from "../services/workspace-merge-execution.service.js";
import { runWorkspacePostMergeCleanup } from "../services/workspace-merge-cleanup.service.js";
import { WorkspaceError } from "../services/workspace-internals.js";

vi.mock("@agentic-kanban/shared/lib/openspec", () => ({
  OPENSPEC_CHANGES_DIR: "openspec/changes",
  OPENSPEC_SPECS_DIR: "openspec/specs",
  validateOpenSpecChange: vi.fn(async () => ({ valid: true, errors: [], warnings: [], deltas: [] })),
  applyOpenSpecDeltas: vi.fn(async () => ({ valid: true, errors: [], warnings: [], applied: [] })),
}));

vi.mock("../services/workspace-teardown.service.js", () => ({
  teardownWorktree: vi.fn(async () => {}),
}));

vi.mock("../services/workspace-code-metrics.service.js", () => ({
  computeWorkspaceCodeMetrics: vi.fn(async () => null),
}));

vi.mock("../services/github-handoff-draft.service.js", () => ({
  generateAndPersistGithubHandoffDraft: vi.fn(async () => null),
}));

vi.mock("../services/merge-helpers.service.js", () => ({
  rebuildSharedIfChanged: vi.fn(async () => null),
  runLearningStep: vi.fn(async () => null),
}));

vi.mock("../services/followup-workspace.service.js", () => ({
  autoStartFollowups: vi.fn(async () => null),
}));

vi.mock("../services/dependency-auto-chain.service.js", () => ({
  autoStartUnblockedDependencyIssue: vi.fn(async () => null),
}));

function makeWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    issueId: randomUUID(),
    branch: "feature/test",
    workingDir: "/repo/.worktrees/feature-test",
    baseBranch: "master",
    isDirect: false,
    status: "idle",
    readyForMerge: true,
    mergedAt: null,
    provider: "claude",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeGit(overrides: Record<string, unknown> = {}) {
  return {
    countBehindCommits: vi.fn(async () => 0),
    rebaseOntoBase: vi.fn(async () => ({ success: true })),
    abortRebase: vi.fn(async () => {}),
    detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
    autoRenumberMigrations: vi.fn(async () => ({ renumbered: false, renames: [] })),
    getCurrentBranch: vi.fn(async () => "master"),
    getChangedFilesBetween: vi.fn(async () => []),
    syncBranchToHead: vi.fn(async () => false),
    revParse: vi.fn(async () => "head-sha"),
    mergeBranch: vi.fn(async () => "Merge made by the 'ort' strategy."),
    checkBranchTipIsAncestor: vi.fn(async () => ({ isAncestor: true, branchSha: "branch-sha", baseSha: "head-sha" })),
    removeWorktree: vi.fn(async () => {}),
    deleteBranch: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("workspace merge conflict detection service", () => {
  it("reports auto-rebase conflicts with behindCount and aborts the rebase", async () => {
    const git = makeGit({
      countBehindCommits: vi.fn(async () => 3),
      rebaseOntoBase: vi.fn(async () => ({ success: false, conflictingFiles: ["src/a.ts"] })),
    });

    const result = await detectWorkspaceMergeConflicts({
      workspace: makeWorkspace() as never,
      repoPath: "/repo",
      baseBranch: "master",
      gitService: git as never,
    });

    expect(result).toEqual({ kind: "conflict", conflictFiles: ["src/a.ts"], behindCount: 3 });
    expect(git.abortRebase).toHaveBeenCalledWith("/repo/.worktrees/feature-test");
  });

  it("reports read-only merge-tree conflicts when the branch is current", async () => {
    const git = makeGit({
      detectConflicts: vi.fn(async () => ({ hasConflicts: true, conflictingFiles: ["src/b.ts"] })),
    });

    await expect(detectWorkspaceMergeConflicts({
      workspace: makeWorkspace() as never,
      repoPath: "/repo",
      baseBranch: "master",
      gitService: git as never,
    })).resolves.toEqual({ kind: "conflict", conflictFiles: ["src/b.ts"] });
  });
});

describe("workspace merge pre-validation service", () => {
  beforeEach(() => {
    vi.mocked(validateOpenSpecChange).mockResolvedValue({ valid: true, errors: [], warnings: [], deltas: [] });
  });

  it("auto-renumbers migrations before OpenSpec validation", async () => {
    const git = makeGit();

    await runWorkspacePreMergeValidation({
      workspace: makeWorkspace() as never,
      repoPath: "/repo",
      baseBranch: "master",
      gitService: git as never,
    });

    expect(git.autoRenumberMigrations).toHaveBeenCalledWith("/repo/.worktrees/feature-test", "/repo", "master");
    expect(validateOpenSpecChange).toHaveBeenCalledWith("/repo/.worktrees/feature-test");
  });

  it("rejects OpenSpec deltas when the main checkout is on the wrong branch", async () => {
    vi.mocked(validateOpenSpecChange).mockResolvedValue({
      valid: true,
      errors: [],
      warnings: [],
      deltas: [{
        domain: "billing",
        changeId: "change-1",
        path: "openspec/changes/change-1/specs/billing/spec.md",
        added: "",
        modified: "",
        removed: "",
      }],
    });
    const git = makeGit({ getCurrentBranch: vi.fn(async () => "feature/other") });

    await expect(runWorkspacePreMergeValidation({
      workspace: makeWorkspace() as never,
      repoPath: "/repo",
      baseBranch: "master",
      gitService: git as never,
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("workspace merge execution service", () => {
  it("wraps git merge failures as conflict WorkspaceErrors and records the attempt", async () => {
    const workspace = makeWorkspace();
    const recordMergeAttempt = vi.fn(async () => {});
    const git = makeGit({ mergeBranch: vi.fn(async () => { throw new Error("boom"); }) });

    await expect(executeWorkspaceMerge({
      id: workspace.id,
      workspace: workspace as never,
      repoPath: "/repo",
      targetBranch: "master",
      database: {} as never,
      gitService: git as never,
      createBackup: async () => {},
      recordMergeAttempt,
    })).rejects.toBeInstanceOf(WorkspaceError);

    expect(recordMergeAttempt).toHaveBeenCalledWith(
      workspace,
      "conflict",
      expect.stringContaining("boom"),
      { step: "git-merge", targetBranch: "master" },
    );
  });
});

describe("workspace merge cleanup service", () => {
  it("tears down, removes the worktree, and deletes the branch", async () => {
    const git = makeGit();

    await runWorkspacePostMergeCleanup({
      workspaceId: randomUUID(),
      issueId: randomUUID(),
      repoPath: "/repo",
      preMergeHead: "",
      prefMap: new Map(),
      projectId: null,
      workingDir: "/repo/.worktrees/feature-test",
      branch: "feature/test",
      mergeResult: "ok",
      teardownScript: null,
      setupEnabled: true,
      isDirect: false,
    }, {
      database: {} as never,
      gitService: git as never,
      killProcesses: vi.fn(async () => 0),
    });

    expect(git.removeWorktree).toHaveBeenCalledWith("/repo", "/repo/.worktrees/feature-test");
    expect(git.deleteBranch).toHaveBeenCalledWith("/repo", "feature/test");
  });
});
