import { describe, it, expect } from "vitest";
import {
  SERVER_BOARD_EVENT_REASONS,
  EXTERNAL_BOARD_EVENT_REASONS,
  PROJECT_EVENT_REASONS,
  BOARD_EVENT_REASONS,
  CLIENT_SYNTHETIC_REASONS,
  isBoardEventReason,
  WORKSPACE_LIFECYCLE_REASONS,
  SESSION_LIFECYCLE_REASONS,
  WORKFLOW_REASONS,
  DRIVE_REASONS,
  LIVE_ACTIVITY_REFRESH_REASONS,
} from "../src/lib/board-events-contract.js";

/**
 * The board WS event vocabulary (#566). The named ReadonlySets replace five hand-built
 * filters that had drifted from each other and from what the server actually broadcasts
 * (three listed `workspace_updated`, a reason nothing ever sends) — so these tests pin
 * both membership and the union arithmetic, not just "doesn't throw".
 */
describe("board-events-contract", () => {
  it("BOARD_EVENT_REASONS is exactly the union of server + external reasons, no dupes", () => {
    expect(BOARD_EVENT_REASONS).toEqual([
      ...SERVER_BOARD_EVENT_REASONS,
      ...EXTERNAL_BOARD_EVENT_REASONS,
    ]);
    expect(new Set(BOARD_EVENT_REASONS).size).toBe(BOARD_EVENT_REASONS.length);
  });

  it("server and external reason lists do not overlap", () => {
    const external = new Set(EXTERNAL_BOARD_EVENT_REASONS as readonly string[]);
    for (const reason of SERVER_BOARD_EVENT_REASONS) {
      expect(external.has(reason)).toBe(false);
    }
  });

  it("PROJECT_EVENT_REASONS is kept separate from BOARD_EVENT_REASONS", () => {
    const board = new Set(BOARD_EVENT_REASONS as readonly string[]);
    for (const reason of PROJECT_EVENT_REASONS) {
      expect(board.has(reason)).toBe(false);
    }
    expect(PROJECT_EVENT_REASONS).toEqual(["project_created", "project_updated", "project_deleted"]);
  });

  describe("isBoardEventReason", () => {
    it("accepts every server and external reason", () => {
      for (const reason of BOARD_EVENT_REASONS) {
        expect(isBoardEventReason(reason)).toBe(true);
      }
    });

    it("rejects a project reason — those travel on a different message type", () => {
      expect(isBoardEventReason("project_created")).toBe(false);
    });

    it("rejects a synthetic client-only reason", () => {
      expect(isBoardEventReason("reconnect")).toBe(false);
      expect(isBoardEventReason("poll")).toBe(false);
    });

    it("rejects the retired reason that used to silently filter nothing", () => {
      expect(isBoardEventReason("workspace_updated")).toBe(false);
    });

    it("rejects non-string and unknown values", () => {
      expect(isBoardEventReason(undefined)).toBe(false);
      expect(isBoardEventReason(42)).toBe(false);
      expect(isBoardEventReason("totally_made_up")).toBe(false);
    });
  });

  describe("named refresh-reason groups", () => {
    it("WORKSPACE_LIFECYCLE_REASONS covers create/setup/idle/merge/close/ready-for-merge", () => {
      expect([...WORKSPACE_LIFECYCLE_REASONS].sort()).toEqual(
        [
          "workspace_created",
          "workspace_setup",
          "workspace_idle",
          "workspace_merged",
          "workspace_closed",
          "workspace_ready_for_merge",
        ].sort(),
      );
    });

    it("SESSION_LIFECYCLE_REASONS covers launched/stopped/completed", () => {
      expect([...SESSION_LIFECYCLE_REASONS].sort()).toEqual(
        ["session_launched", "session_stopped", "session_completed"].sort(),
      );
    });

    it("WORKFLOW_REASONS covers error/fork/join/transition/template save+delete", () => {
      expect([...WORKFLOW_REASONS].sort()).toEqual(
        [
          "workflow_error",
          "workflow_fork",
          "workflow_join",
          "workflow_transition",
          "workflow_template_saved",
          "workflow_template_deleted",
        ].sort(),
      );
    });

    it("DRIVE_REASONS covers started/finished/obstacle", () => {
      expect([...DRIVE_REASONS].sort()).toEqual(
        ["drive_started", "drive_finished", "drive_obstacle"].sort(),
      );
    });

    it("LIVE_ACTIVITY_REFRESH_REASONS unions board_changed, workspace and session lifecycle, and synthetic reasons", () => {
      const expected = new Set<string>([
        "board_changed",
        ...WORKSPACE_LIFECYCLE_REASONS,
        ...SESSION_LIFECYCLE_REASONS,
        ...CLIENT_SYNTHETIC_REASONS,
      ]);
      expect(new Set(LIVE_ACTIVITY_REFRESH_REASONS)).toEqual(expected);
    });

    it("LIVE_ACTIVITY_REFRESH_REASONS includes workspace_idle and workspace_ready_for_merge", () => {
      // Regression: two of three prior hand-built sets omitted these.
      expect(LIVE_ACTIVITY_REFRESH_REASONS.has("workspace_idle")).toBe(true);
      expect(LIVE_ACTIVITY_REFRESH_REASONS.has("workspace_ready_for_merge")).toBe(true);
    });

    it("LIVE_ACTIVITY_REFRESH_REASONS does not include workflow or drive reasons", () => {
      expect(LIVE_ACTIVITY_REFRESH_REASONS.has("workflow_error")).toBe(false);
      expect(LIVE_ACTIVITY_REFRESH_REASONS.has("drive_started")).toBe(false);
    });
  });
});
