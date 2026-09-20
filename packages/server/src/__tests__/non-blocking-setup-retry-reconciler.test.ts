// @covers workspaces.nonBlockingSetupRetry [recovery, boundary]
//
// #1125 ask 3 — the pure decision function for the non-blocking setup path's own retry.
import { describe, expect, it } from "vitest";
import {
  decideNonBlockingSetupRetryAction,
  NON_BLOCKING_SETUP_RETRY_INTERVAL_MS,
  type NonBlockingSetupRow,
} from "../startup/non-blocking-setup-retry-reconciler.js";

const NOW = Date.parse("2026-09-13T12:00:00.000Z");

function row(overrides: Partial<NonBlockingSetupRow> = {}): NonBlockingSetupRow {
  return {
    workspaceId: "ws-1",
    workingDir: "/repo/.worktrees/ws-1",
    setupScript: "pnpm install -r",
    setupState: "failed",
    setupEndedAt: new Date(NOW - 2 * NON_BLOCKING_SETUP_RETRY_INTERVAL_MS).toISOString(),
    setupStdoutTail: "ERR_PNPM_UNKNOWN  UNKNOWN: unknown error, stat 'C:\\.pnpm-store\\v10\\files\\42\\x'",
    setupStderrTail: null,
    ...overrides,
  };
}

describe("decideNonBlockingSetupRetryAction (#1125)", () => {
  it("skips a workspace with no recorded setup failure", () => {
    expect(decideNonBlockingSetupRetryAction(row({ setupState: "succeeded" }), NOW).action).toBe("skip");
  });

  it("skips when there is no script or worktree left to retry", () => {
    expect(decideNonBlockingSetupRetryAction(row({ setupScript: null }), NOW).action).toBe("skip");
    expect(decideNonBlockingSetupRetryAction(row({ workingDir: null }), NOW).action).toBe("skip");
  });

  it("skips a failure that is not the classified I/O fault — left to the butler event", () => {
    const result = decideNonBlockingSetupRetryAction(
      row({ setupStdoutTail: null, setupStderrTail: "ERR_PNPM_FETCH_404 Not Found" }),
      NOW,
    );
    expect(result.action).toBe("skip");
    expect(result.reason).toContain("butler event");
  });

  it("holds within the retry interval", () => {
    const result = decideNonBlockingSetupRetryAction(
      row({ setupEndedAt: new Date(NOW - 5 * 60 * 1000).toISOString() }),
      NOW,
    );
    expect(result.action).toBe("hold");
  });

  it("retries a classified I/O fault outside the retry interval", () => {
    const result = decideNonBlockingSetupRetryAction(row(), NOW);
    expect(result.action).toBe("retry-setup");
  });
});
