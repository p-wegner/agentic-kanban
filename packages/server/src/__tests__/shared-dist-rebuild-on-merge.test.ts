/**
 * Regression tests for #617: auto-rebuild shared package dist when server-side
 * dependency exports change.
 *
 * The bug: rebuildSharedIfChanged() was inside the same try block as
 * generateAndPersistGithubHandoffDraft(). If the handoff draft threw, the rebuild
 * was silently skipped — leaving shared/dist stale and breaking the server on the
 * next restart or in published/production mode.
 *
 * Fix: rebuild runs in its own try/catch, independent of the handoff draft.
 */
// vi.mock must come before imports — vitest hoists these calls to the top of the module
vi.mock("../services/github-handoff-draft.service.js", () => ({
  generateAndPersistGithubHandoffDraft: vi.fn(async () => ({ artifactId: "test-id", content: "test" })),
}));

vi.mock("../services/merge-helpers.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/merge-helpers.service.js")>();
  return {
    ...actual,
    rebuildSharedIfChanged: vi.fn(async () => {}),
    runLearningStep: vi.fn(async () => {}),
  };
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { issues, projectStatuses, projects, workspaces } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import * as handoffDraftModule from "../services/github-handoff-draft.service.js";
import * as mergeHelpersModule from "../services/merge-helpers.service.js";
import { createWorkspaceMergeService } from "../services/workspace-merge.service.js";

function makeGit(changedFiles: string[] = []) {
  return {
    getDiff: vi.fn(async () => ""),
    revParse: vi.fn(async (_repo: string, _ref: string) => "merge-sha"),
    isAncestor: vi.fn(async () => false),
    mergeBranch: vi.fn(async () => "Merge made by the 'ort' strategy."),
    detectConflicts: vi.fn(async () => ({ hasConflicts: false, conflictingFiles: [] })),
    syncBranchToHead: vi.fn(async () => false),
    removeWorktree: vi.fn(async () => {}),
    deleteBranch: vi.fn(async () => {}),
    getChangedFilesBetween: vi.fn(async () => changedFiles),
    getCommitSummariesBetween: vi.fn(async () => []),
    getCurrentBranch: vi.fn(async () => "master"),
    autoRenumberMigrations: vi.fn(async () => ({ renumbered: false, renames: [] })),
    checkBranchTipIsAncestor: vi.fn(async () => ({
      isAncestor: true as const, branchSha: "branch-sha", baseSha: "merge-sha",
    })),
    getUncommittedTrackedChanges: vi.fn(async () => []),
    countUniqueCommits: vi.fn(async () => 1),
    countBehindCommits: vi.fn(async () => 0),
    rebaseOntoBase: vi.fn(async () => ({ success: true })),
    mergeBaseIntoBranch: vi.fn(async () => ({ success: true })),
    abortRebase: vi.fn(async () => {}),
  };
}

async function seedWorkspace(db: ReturnType<typeof createTestDb>["db"]) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  const inReviewStatusId = randomUUID();
  const doneStatusId = randomUUID();
  const issueId = randomUUID();
  const workspaceId = randomUUID();

  await db.insert(projects).values({
    id: projectId,
    name: "Test",
    repoPath: "/repo",
    repoName: "repo",
    defaultBranch: "master",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(projectStatuses).values([
    { id: inReviewStatusId, projectId, name: "In Review", sortOrder: 2, isDefault: false, createdAt: now },
    { id: doneStatusId, projectId, name: "Done", sortOrder: 3, isDefault: false, createdAt: now },
  ]);
  await db.insert(issues).values({
    id: issueId,
    issueNumber: 617,
    title: "Shared dist rebuild test issue",
    priority: "medium",
    sortOrder: 0,
    statusId: inReviewStatusId,
    projectId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/ak-617-test",
    workingDir: null,
    baseBranch: "master",
    isDirect: false,
    status: "idle",
    readyForMerge: true,
    provider: "claude",
    createdAt: now,
    updatedAt: now,
  });

  return { projectId, issueId, workspaceId };
}

describe("shared dist rebuild on merge (#617)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
    vi.mocked(mergeHelpersModule.rebuildSharedIfChanged).mockReset();
    vi.mocked(mergeHelpersModule.rebuildSharedIfChanged).mockResolvedValue();
    vi.mocked(handoffDraftModule.generateAndPersistGithubHandoffDraft).mockReset();
    vi.mocked(handoffDraftModule.generateAndPersistGithubHandoffDraft).mockResolvedValue(
      { artifactId: "test-id", content: "test" },
    );
  });

  it("calls rebuildSharedIfChanged when shared/src files changed", async () => {
    const { workspaceId } = await seedWorkspace(db);
    const git = makeGit(["packages/shared/src/lib/git-service.ts"]);

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await svc.mergeWorkspace(workspaceId);
    await vi.waitFor(() => {
      expect(mergeHelpersModule.rebuildSharedIfChanged).toHaveBeenCalledWith(
        "/repo",
        expect.arrayContaining(["packages/shared/src/lib/git-service.ts"]),
      );
    }, { timeout: 3000 });
  });

  it("still calls rebuildSharedIfChanged when generateAndPersistGithubHandoffDraft throws (regression #617)", async () => {
    const { workspaceId } = await seedWorkspace(db);

    // Handoff draft fails — before the fix this caused the rebuild to be skipped
    vi.mocked(handoffDraftModule.generateAndPersistGithubHandoffDraft).mockRejectedValue(
      new Error("handoff draft failed"),
    );

    const git = makeGit(["packages/shared/src/lib/git-service.ts"]);

    const svc = createWorkspaceMergeService({
      database: db,
      gitService: git as never,
      createBackup: async () => {},
      processKiller: async () => 0,
    });

    await svc.mergeWorkspace(workspaceId);
    await vi.waitFor(() => {
      expect(mergeHelpersModule.rebuildSharedIfChanged).toHaveBeenCalledWith(
        "/repo",
        expect.arrayContaining(["packages/shared/src/lib/git-service.ts"]),
      );
    }, { timeout: 3000 });
  });
});
