import { describe, expect, it, vi } from "vitest";
import { sendMonitorNudge } from "../services/monitor-nudge.js";

describe("sendMonitorNudge", () => {
  it("sends the monitor nudge prompt as a session turn and records the action", () => {
    const sendTurn = vi.fn(() => ({ ok: true }));
    const logAction = vi.fn();
    const broadcast = vi.fn();
    const logger = { log: vi.fn(), warn: vi.fn() };

    const nudged = sendMonitorNudge({
      sessionManager: { sendTurn },
      sessionId: "session-1",
      workspaceId: "workspace-1",
      issueId: "issue-1",
      projectId: "project-1",
      prompt: "Please continue.",
      logAction,
      broadcast,
      logger,
    });

    expect(nudged).toBe(true);
    expect(sendTurn).toHaveBeenCalledWith("session-1", "Please continue.");
    expect(logAction).toHaveBeenCalledWith("nudge", "workspace-1", "issue-1");
    expect(broadcast).toHaveBeenCalledWith("project-1", "board_changed");
    expect(logger.log).toHaveBeenCalledWith("[monitor] Nudged long-running agent in workspace workspace-1");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("does not record a nudge when sendTurn rejects it", () => {
    const sendTurn = vi.fn(() => ({ ok: false, error: "Agent is still processing the previous turn" }));
    const logAction = vi.fn();
    const broadcast = vi.fn();
    const logger = { log: vi.fn(), warn: vi.fn() };

    const nudged = sendMonitorNudge({
      sessionManager: { sendTurn },
      sessionId: "session-1",
      workspaceId: "workspace-1",
      issueId: "issue-1",
      projectId: "project-1",
      prompt: "Please continue.",
      logAction,
      broadcast,
      logger,
    });

    expect(nudged).toBe(false);
    expect(sendTurn).toHaveBeenCalledWith("session-1", "Please continue.");
    expect(logAction).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "[monitor] Failed to nudge workspace workspace-1: Agent is still processing the previous turn",
    );
  });
});
