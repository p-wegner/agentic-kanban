import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupScheduledTasks } from "../startup/scheduled-tasks.js";
import { startAutoMergeOrchestrator } from "../startup/auto-merge-orchestrator.js";
import { startAncestorBranchReconciler } from "../startup/ancestor-branch-reconciler.js";
import { startDoneUnmergedScanner } from "../startup/done-unmerged-invariant-scanner.js";
import { startStrandedReviewReconciler } from "../startup/stranded-review-reconciler.js";
import { startZombieFixSessionReconciler } from "../startup/zombie-fix-session-reconciler.js";
import { startBackupScheduler } from "../startup/backup-scheduler.js";
import { startSessionMessagePruner } from "../services/session-message-pruner.service.js";

interface TimerTestState {
  clearInterval: ReturnType<typeof vi.spyOn>;
  clearTimeout: ReturnType<typeof vi.spyOn>;
}

describe("startup timers are restart-safe for HMR-style reloads", () => {
  let clearIntervalSpy: TimerTestState["clearInterval"];
  let clearTimeoutSpy: TimerTestState["clearTimeout"];

  beforeEach(() => {
    vi.useFakeTimers();
    clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("recreates scheduled-tasks timers instead of accumulating handles", () => {
    const first = setupScheduledTasks(4123);
    const second = setupScheduledTasks(4123);

    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(first.timer).not.toBe(second.timer);
    expect(first.interval).not.toBe(second.interval);
  });

  it("recreates ancestor-branch reconciler timers instead of accumulating handles", () => {
    const first = startAncestorBranchReconciler({}, 10_000);
    const second = startAncestorBranchReconciler({}, 10_000);

    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(first.timer).not.toBe(second.timer);
    expect(first.interval).not.toBe(second.interval);
  });

  it("recreates done-unmerged scanner timers instead of accumulating handles", () => {
    const first = startDoneUnmergedScanner({}, 10_000);
    const second = startDoneUnmergedScanner({}, 10_000);

    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(first.timer).not.toBe(second.timer);
    expect(first.interval).not.toBe(second.interval);
  });

  it("recreates auto-merge orchestrator timer instead of accumulating handles", () => {
    const deps = {
      database: {} as unknown as Record<string, never>,
      boardEvents: {
        startCleanup: vi.fn(),
        cleanupStaleConnections: vi.fn(),
      } as unknown as Record<string, never>,
      getSessionManager: () => ({}) as unknown as Record<string, never>,
    };
    const first = startAutoMergeOrchestrator(deps, 60_000);
    const second = startAutoMergeOrchestrator(deps, 60_000);

    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(first.timer).not.toBe(second.timer);
  });

  it("recreates stranded-review reconciler timer instead of accumulating handles", () => {
    const deps = {
      database: {} as unknown as Record<string, never>,
      getSessionManager: () => ({}) as unknown as Record<string, never>,
      boardEvents: { broadcast: vi.fn() } as unknown as Record<string, never>,
      reviewSessionIds: new Set<string>(),
    };
    const first = startStrandedReviewReconciler(deps, 60_000);
    const second = startStrandedReviewReconciler(deps, 60_000);

    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(first).not.toBe(second);
  });

  it("recreates zombie-fix reconciler timer instead of accumulating handles", () => {
    const deps = {
      boardEvents: { broadcast: vi.fn(), broadcastActivity: vi.fn() } as unknown as Record<string, never>,
      database: {} as unknown as Record<string, never>,
    };
    const first = startZombieFixSessionReconciler(deps, 60_000);
    const second = startZombieFixSessionReconciler(deps, 60_000);

    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(first).not.toBe(second);
  });

  it("recreates backup scheduler handles instead of accumulating interval and timeout", () => {
    const first = startBackupScheduler(5);
    const second = startBackupScheduler(5);

    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(first).not.toBe(second);
    expect(second).not.toBeNull();
  });

  it("recreates session message pruner timer handles instead of accumulating interval and timeout", () => {
    startSessionMessagePruner({} as unknown as Record<string, never>);
    startSessionMessagePruner({} as unknown as Record<string, never>);

    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
  });
});
