import { describe, it, expect, vi, beforeEach } from "vitest";
import * as gitService from "../services/git.service.js";

// Mock module-level dependencies that reconcileSilentlyMergedWorkspaces imports
vi.mock("../db/index.js", () => ({
  db: {},
  rawClient: {},
}));
vi.mock("../services/git.service.js", () => ({
  isMergeInProgress: vi.fn(async () => false),
  abortMerge: vi.fn(async () => {}),
  removeWorktree: vi.fn(async () => {}),
  isRebaseInProgress: vi.fn(async () => false),
  abortRebase: vi.fn(async () => {}),
  deleteBranch: vi.fn(async () => {}),
}));
vi.mock("../db/manual-migrate.js", () => ({ applyMigrations: vi.fn(async () => {}) }));
vi.mock("../db/seed.js", () => ({ ensureBuiltinTags: vi.fn(async () => {}), ensureBuiltinSkills: vi.fn(async () => {}) }));
vi.mock("../services/project-registration.js", () => ({ deduplicateProjects: vi.fn(async () => {}) }));
vi.mock("../services/agent.service.js", () => ({}));

// The doubles carry the real input types so `mock.calls[0][0]` is the call's argument
// rather than an empty tuple.
import type { FinalizeMergeCleanupInput, ReconcileMergedIssueInput } from "../services/merge-cleanup.service.js";
import type { LogBoardHealthEventInput } from "../repositories/board-health-events.repository.js";
import type { updateWorkspaceStatus, moveIssueToDone } from "../repositories/workspace.repository.js";

const mockUpdateWorkspaceStatus = vi.fn<typeof updateWorkspaceStatus>(async () => {});
const mockMoveIssueToDone = vi.fn<typeof moveIssueToDone>(async () => {});
const mockFinalizeMergeCleanup = vi.fn(async (_input: FinalizeMergeCleanupInput) => ({
  projectId: "project-id",
  closedAt: new Date().toISOString(),
  mergedAt: new Date().toISOString(),
  workspaceUpdated: true,
  issueTransitioned: true,
  broadcasted: false,
}));
const mockReconcileMergedIssue = vi.fn(async (_input: ReconcileMergedIssueInput) => ({
  projectId: "project-id",
  issueTransitioned: true,
  targetStatusId: "done-status-id",
}));
const mockLogBoardHealthEvent = vi.fn(async (_input: LogBoardHealthEventInput) => "event-id");

vi.mock("../repositories/workspace.repository.js", () => ({
  updateWorkspaceStatus: (...args: Parameters<typeof updateWorkspaceStatus>) => mockUpdateWorkspaceStatus(...args),
  moveIssueToDone: (...args: Parameters<typeof moveIssueToDone>) => mockMoveIssueToDone(...args),
}));

vi.mock("../services/merge-cleanup.service.js", () => ({
  finalizeMergeCleanup: (...args: Parameters<typeof mockFinalizeMergeCleanup>) => mockFinalizeMergeCleanup(...args),
  reconcileMergedIssue: (...args: Parameters<typeof mockReconcileMergedIssue>) => mockReconcileMergedIssue(...args),
}));

vi.mock("../repositories/board-health-events.repository.js", () => ({
  logBoardHealthEvent: (...args: Parameters<typeof mockLogBoardHealthEvent>) => mockLogBoardHealthEvent(...args),
}));

import { reconcileSilentlyMergedWorkspaces } from "../startup/startup-tasks.js";

function makeDb(rows: unknown[]) {
  const whereFn = vi.fn(() => Promise.resolve(rows));
  const secondInnerJoinFn = vi.fn(() => ({ where: whereFn }));
  const firstInnerJoinFn = vi.fn(() => ({ innerJoin: secondInnerJoinFn }));
  const fromFn = vi.fn(() => ({ innerJoin: firstInnerJoinFn }));
  const selectFn = vi.fn(() => ({ from: fromFn }));
  return { select: selectFn } as unknown as Parameters<typeof reconcileSilentlyMergedWorkspaces>[0];
}

describe("reconcileSilentlyMergedWorkspaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when no stale merged workspaces exist", async () => {
    const database = makeDb([]);
    await reconcileSilentlyMergedWorkspaces(database);
    expect(mockFinalizeMergeCleanup).not.toHaveBeenCalled();
  });

  it("closes a workspace that has mergedAt set but status=idle (dropped HTTP response scenario)", async () => {
    const mergedAt = new Date(Date.now() - 60_000).toISOString();
    const database = makeDb([
      {
        id: "ws-1",
        issueId: "issue-1",
        mergedAt,
        closedAt: null,
        branch: "feature/ak-99-test",
        isDirect: false,
        repoPath: "/tmp/repo",
        issueNumber: 99,
        projectId: "proj-1",
      },
    ]);

    await reconcileSilentlyMergedWorkspaces(database);

    expect(mockFinalizeMergeCleanup).toHaveBeenCalledTimes(1);
    const [input] = mockFinalizeMergeCleanup.mock.calls[0];
    expect(input).toMatchObject({
      workspaceId: "ws-1",
      issueId: "issue-1",
      mergedAt,
      workingDir: null,
      projectId: "proj-1",
    });
    expect(input.closedAt).toBeTruthy();
  });

  it("converges the issue to Done via the shared reconcileMergedIssue helper (both-paths contract)", async () => {
    const mergedAt = new Date(Date.now() - 60_000).toISOString();
    const database = makeDb([
      {
        id: "ws-1",
        issueId: "issue-1",
        mergedAt,
        closedAt: null,
        branch: "feature/ak-99-test",
        isDirect: false,
        repoPath: "/tmp/repo",
        issueNumber: 99,
        projectId: "proj-1",
      },
    ]);

    await reconcileSilentlyMergedWorkspaces(database);

    expect(mockReconcileMergedIssue).toHaveBeenCalledTimes(1);
    const [issueInput] = mockReconcileMergedIssue.mock.calls[0];
    expect(issueInput).toMatchObject({ issueId: "issue-1", projectId: "proj-1" });
  });

  it("emits a board health action event for each reconciled workspace", async () => {
    const mergedAt = new Date(Date.now() - 60_000).toISOString();
    const database = makeDb([
      {
        id: "ws-2",
        issueId: "issue-2",
        mergedAt,
        closedAt: null,
        branch: "feature/ak-42-thing",
        isDirect: false,
        repoPath: "/tmp/repo",
        issueNumber: 42,
        projectId: "proj-2",
      },
    ]);

    await reconcileSilentlyMergedWorkspaces(database);

    expect(mockLogBoardHealthEvent).toHaveBeenCalledTimes(1);
    const [eventInput] = mockLogBoardHealthEvent.mock.calls[0];
    expect(eventInput.projectId).toBe("proj-2");
    expect(eventInput.eventType).toBe("action");
    expect(eventInput.category).toBe("merge");
    expect(eventInput.issueNumber).toBe(42);
    expect(eventInput.summary).toContain("feature/ak-42-thing");
    expect(eventInput.summary).toContain("already merged");
  });

  it("handles multiple stale workspaces, reconciling each independently", async () => {
    const mergedAt = new Date(Date.now() - 120_000).toISOString();
    const database = makeDb([
      {
        id: "ws-a",
        issueId: "issue-a",
        mergedAt,
        closedAt: null,
        branch: "feature/a",
        isDirect: false,
        repoPath: "/tmp/repo",
        issueNumber: 1,
        projectId: "p",
      },
      {
        id: "ws-b",
        issueId: "issue-b",
        mergedAt,
        closedAt: null,
        branch: "feature/b",
        isDirect: false,
        repoPath: "/tmp/repo",
        issueNumber: 2,
        projectId: "p",
      },
    ]);

    await reconcileSilentlyMergedWorkspaces(database);

    expect(mockFinalizeMergeCleanup).toHaveBeenCalledTimes(2);
  });

  it("preserves existing closedAt when workspace already has it", async () => {
    const mergedAt = new Date(Date.now() - 60_000).toISOString();
    const existingClosedAt = new Date(Date.now() - 30_000).toISOString();
    const database = makeDb([
      {
        id: "ws-3",
        issueId: "issue-3",
        mergedAt,
        closedAt: existingClosedAt,
        branch: "feature/ak-50-x",
        isDirect: false,
        repoPath: "/tmp/repo",
        issueNumber: 50,
        projectId: "proj-1",
      },
    ]);

    await reconcileSilentlyMergedWorkspaces(database);

    const [input] = mockFinalizeMergeCleanup.mock.calls[0];
    expect(input.closedAt).toBe(existingClosedAt);
  });

  it("is non-fatal when the db query throws", async () => {
    const brokenDb = {
      select: vi.fn(() => { throw new Error("db unavailable"); }),
    } as unknown as Parameters<typeof reconcileSilentlyMergedWorkspaces>[0];

    await expect(reconcileSilentlyMergedWorkspaces(brokenDb)).resolves.toBeUndefined();
    expect(mockFinalizeMergeCleanup).not.toHaveBeenCalled();
  });

  it("continues to next workspace when one fails, not throwing", async () => {
    const mergedAt = new Date(Date.now() - 60_000).toISOString();
    const database = makeDb([
      {
        id: "ws-fail",
        issueId: "issue-fail",
        mergedAt,
        closedAt: null,
        branch: "feature/fail",
        isDirect: false,
        repoPath: "/tmp/repo",
        issueNumber: 10,
        projectId: "p",
      },
      {
        id: "ws-ok",
        issueId: "issue-ok",
        mergedAt,
        closedAt: null,
        branch: "feature/ok",
        isDirect: false,
        repoPath: "/tmp/repo",
        issueNumber: 11,
        projectId: "p",
      },
    ]);

    mockFinalizeMergeCleanup
      .mockRejectedValueOnce(new Error("DB lock"))
      .mockResolvedValueOnce({
        projectId: "project-id",
        closedAt: new Date().toISOString(),
        mergedAt,
        workspaceUpdated: true,
        issueTransitioned: true,
        broadcasted: false,
      });

    await expect(reconcileSilentlyMergedWorkspaces(database)).resolves.toBeUndefined();

    // Second workspace should still be processed
    expect(mockFinalizeMergeCleanup).toHaveBeenCalledTimes(2);
    expect(mockFinalizeMergeCleanup.mock.calls[1][0].workspaceId).toBe("ws-ok");
  });

  it("deletes feature branches for non-direct reconciled workspaces", async () => {
    const mergedAt = new Date(Date.now() - 60_000).toISOString();
    const database = makeDb([
      {
        id: "ws-4",
        issueId: "issue-4",
        mergedAt,
        closedAt: null,
        branch: "feature/cleanup",
        isDirect: false,
        repoPath: "/tmp/repo",
        issueNumber: 77,
        projectId: "proj-4",
      },
    ]);

    await reconcileSilentlyMergedWorkspaces(database);

    expect(vi.mocked(gitService.deleteBranch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gitService.deleteBranch)).toHaveBeenCalledWith("/tmp/repo", "feature/cleanup");
  });

  it("skips branch deletion for direct workspaces", async () => {
    const mergedAt = new Date(Date.now() - 60_000).toISOString();
    const database = makeDb([
      {
        id: "ws-5",
        issueId: "issue-5",
        mergedAt,
        closedAt: null,
        branch: "feature/direct-cleanup",
        isDirect: true,
        repoPath: "/tmp/repo",
        issueNumber: 78,
        projectId: "proj-5",
      },
    ]);

    await reconcileSilentlyMergedWorkspaces(database);

    expect(vi.mocked(gitService.deleteBranch)).not.toHaveBeenCalled();
  });
});
