import { describe, it, expect, vi, beforeEach } from "vitest";

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
}));
vi.mock("../db/manual-migrate.js", () => ({ applyMigrations: vi.fn(async () => {}) }));
vi.mock("../db/seed.js", () => ({ ensureBuiltinTags: vi.fn(async () => {}), ensureBuiltinSkills: vi.fn(async () => {}) }));
vi.mock("../services/project-registration.js", () => ({ deduplicateProjects: vi.fn(async () => {}) }));
vi.mock("../services/agent.service.js", () => ({}));

const mockUpdateWorkspaceStatus = vi.fn(async () => {});
const mockMoveIssueToDone = vi.fn(async () => {});
const mockLogBoardHealthEvent = vi.fn(async () => "event-id");

vi.mock("../repositories/workspace.repository.js", () => ({
  updateWorkspaceStatus: (...args: unknown[]) => mockUpdateWorkspaceStatus(...args),
  moveIssueToDone: (...args: unknown[]) => mockMoveIssueToDone(...args),
}));

vi.mock("../repositories/board-health-events.repository.js", () => ({
  logBoardHealthEvent: (...args: unknown[]) => mockLogBoardHealthEvent(...args),
}));

import { reconcileSilentlyMergedWorkspaces } from "../startup/startup-tasks.js";

function makeDb(rows: unknown[]) {
  const whereFn = vi.fn(() => Promise.resolve(rows));
  const innerJoinFn = vi.fn(() => ({ where: whereFn }));
  const fromFn = vi.fn(() => ({ innerJoin: innerJoinFn }));
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
    expect(mockUpdateWorkspaceStatus).not.toHaveBeenCalled();
    expect(mockMoveIssueToDone).not.toHaveBeenCalled();
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
        issueNumber: 99,
        projectId: "proj-1",
      },
    ]);

    await reconcileSilentlyMergedWorkspaces(database);

    expect(mockUpdateWorkspaceStatus).toHaveBeenCalledTimes(1);
    const [wsId, status, extra] = mockUpdateWorkspaceStatus.mock.calls[0];
    expect(wsId).toBe("ws-1");
    expect(status).toBe("closed");
    expect(extra).toMatchObject({ mergedAt, readyForMerge: false, workingDir: null });
    expect(extra.closedAt).toBeTruthy();

    expect(mockMoveIssueToDone).toHaveBeenCalledTimes(1);
    const [movedWsId, movedIssueId] = mockMoveIssueToDone.mock.calls[0];
    expect(movedWsId).toBe("ws-1");
    expect(movedIssueId).toBe("issue-1");
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
      { id: "ws-a", issueId: "issue-a", mergedAt, closedAt: null, branch: "feature/a", issueNumber: 1, projectId: "p" },
      { id: "ws-b", issueId: "issue-b", mergedAt, closedAt: null, branch: "feature/b", issueNumber: 2, projectId: "p" },
    ]);

    await reconcileSilentlyMergedWorkspaces(database);

    expect(mockUpdateWorkspaceStatus).toHaveBeenCalledTimes(2);
    expect(mockMoveIssueToDone).toHaveBeenCalledTimes(2);
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
        issueNumber: 50,
        projectId: "proj-1",
      },
    ]);

    await reconcileSilentlyMergedWorkspaces(database);

    const [, , extra] = mockUpdateWorkspaceStatus.mock.calls[0];
    expect(extra.closedAt).toBe(existingClosedAt);
  });

  it("is non-fatal when the db query throws", async () => {
    const brokenDb = {
      select: vi.fn(() => { throw new Error("db unavailable"); }),
    } as unknown as Parameters<typeof reconcileSilentlyMergedWorkspaces>[0];

    await expect(reconcileSilentlyMergedWorkspaces(brokenDb)).resolves.toBeUndefined();
    expect(mockUpdateWorkspaceStatus).not.toHaveBeenCalled();
  });

  it("continues to next workspace when one fails, not throwing", async () => {
    const mergedAt = new Date(Date.now() - 60_000).toISOString();
    const database = makeDb([
      { id: "ws-fail", issueId: "issue-fail", mergedAt, closedAt: null, branch: "feature/fail", issueNumber: 10, projectId: "p" },
      { id: "ws-ok", issueId: "issue-ok", mergedAt, closedAt: null, branch: "feature/ok", issueNumber: 11, projectId: "p" },
    ]);

    mockUpdateWorkspaceStatus
      .mockRejectedValueOnce(new Error("DB lock"))
      .mockResolvedValueOnce(undefined);

    await expect(reconcileSilentlyMergedWorkspaces(database)).resolves.toBeUndefined();

    // Second workspace should still be processed
    expect(mockUpdateWorkspaceStatus).toHaveBeenCalledTimes(2);
    expect(mockMoveIssueToDone).toHaveBeenCalledTimes(1);
    expect(mockMoveIssueToDone.mock.calls[0][0]).toBe("ws-ok");
  });
});
