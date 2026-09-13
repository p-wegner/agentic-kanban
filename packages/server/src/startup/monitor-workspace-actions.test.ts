import { describe, expect, it, vi, beforeEach } from "vitest";

const launchSession = vi.fn(async () => {});

vi.mock("../services/workspace.service.js", () => ({
  createWorkspaceService: vi.fn(() => ({
    launchSession,
    mergeWorkspaceDeduped: vi.fn(),
    fixAndMerge: vi.fn(),
    deleteWorkspace: vi.fn(),
    updateBase: vi.fn(),
  })),
}));

vi.mock("../repositories/workspace.repository.js", () => ({
  getWorkspaceById: vi.fn(),
}));

vi.mock("../repositories/auto-start.repository.js", () => ({
  hasSkipAutoStartTag: vi.fn(),
}));

import { getWorkspaceById } from "../repositories/workspace.repository.js";
import { hasSkipAutoStartTag } from "../repositories/auto-start.repository.js";
import { createMonitorWorkspaceActions } from "./monitor-workspace-actions.js";

describe("createMonitorWorkspaceActions.launch (#1106/#1108)", () => {
  beforeEach(() => {
    launchSession.mockClear();
    vi.mocked(getWorkspaceById).mockReset();
    vi.mocked(hasSkipAutoStartTag).mockReset();
  });

  function makeActions() {
    return createMonitorWorkspaceActions({
      database: {} as never,
      getSessionManager: () => ({} as never),
      boardEvents: {} as never,
      fixAndMergeSessionIds: new Set<string>(),
    });
  }

  it("skips the relaunch (no throw, launchSession not called) when the issue carries no-auto-start", async () => {
    vi.mocked(getWorkspaceById).mockResolvedValueOnce({ id: "ws-1", issueId: "issue-1" } as never);
    vi.mocked(hasSkipAutoStartTag).mockResolvedValueOnce(true);

    await expect(makeActions().launch("ws-1")).resolves.toBeUndefined();

    expect(launchSession).not.toHaveBeenCalled();
  });

  it("relaunches normally when the issue carries no such tag", async () => {
    vi.mocked(getWorkspaceById).mockResolvedValueOnce({ id: "ws-1", issueId: "issue-1" } as never);
    vi.mocked(hasSkipAutoStartTag).mockResolvedValueOnce(false);

    await makeActions().launch("ws-1");

    expect(launchSession).toHaveBeenCalledWith("ws-1");
  });

  it("relaunches when the workspace lookup comes back empty (fail open, not a reason to block)", async () => {
    vi.mocked(getWorkspaceById).mockResolvedValueOnce(undefined as never);

    await makeActions().launch("ws-1");

    expect(launchSession).toHaveBeenCalledWith("ws-1");
    expect(hasSkipAutoStartTag).not.toHaveBeenCalled();
  });
});
