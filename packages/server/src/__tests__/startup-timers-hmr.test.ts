import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupScheduledTasks } from "../startup/scheduled-tasks.js";
import { startAutoMergeOrchestrator } from "../startup/auto-merge-orchestrator.js";
import { startAncestorBranchReconciler, stopAncestorBranchReconciler } from "../startup/ancestor-branch-reconciler.js";
import { startDoneUnmergedScanner, stopDoneUnmergedScanner } from "../startup/done-unmerged-invariant-scanner.js";
import { startStrandedReviewReconciler } from "../startup/stranded-review-reconciler.js";
import { startZombieFixSessionReconciler } from "../startup/zombie-fix-session-reconciler.js";
import { startBackupScheduler } from "../startup/backup-scheduler.js";
import { startSessionMessagePruner } from "../services/session-message-pruner.service.js";
import { cleanupStartupTimers, replaceStartupTimerCleanup } from "../server-start.js";
import { createBoardEvents } from "../services/board-events.js";
import { createMonitorSetup } from "../startup/monitor-setup.js";
import { startMonitorButler, stopMonitorButler } from "../services/monitor-butler.js";
import { getPreference } from "../repositories/preferences.repository.js";

vi.mock("../repositories/preferences.repository.js", () => ({
  getPreference: vi.fn(),
}));

vi.mock("../db/index.js", () => ({
  db: {
    select: () => ({
      from: () => Promise.resolve([]),
    }),
  },
}));

vi.mock("../services/dirty-main-checkout.js", () => ({
  scanDirtyMainCheckouts: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../services/stale-dev-processes.js", () => ({
  snapshotAndCleanStaleDevProcesses: vi.fn(() => Promise.resolve({
    processes: [],
    listeners: [],
    activeWorkspaces: [],
    kept: [],
    cleaned: [],
  })),
}));

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
    cleanupStartupTimers();
    stopMonitorButler();
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

  it("clears ancestor-branch reconciler interval handles on stop", () => {
    const { timer, interval } = startAncestorBranchReconciler({}, 10_000);

    stopAncestorBranchReconciler();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
    expect(clearIntervalSpy).toHaveBeenCalledWith(interval);
  });

  it("clears done-unmerged scanner interval handles on stop", () => {
    const { timer, interval } = startDoneUnmergedScanner({}, 10_000);

    stopDoneUnmergedScanner();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
    expect(clearIntervalSpy).toHaveBeenCalledWith(interval);
  });

  it("replaces server-start registered timer cleanup instead of accumulating boot handles", () => {
    const firstInterval = setInterval(() => {}, 10_000);
    const secondInterval = setInterval(() => {}, 10_000);

    replaceStartupTimerCleanup([() => clearInterval(firstInterval)]);
    replaceStartupTimerCleanup([() => clearInterval(secondInterval)]);

    expect(clearIntervalSpy).toHaveBeenCalledWith(firstInterval);
    expect(clearIntervalSpy).not.toHaveBeenCalledWith(secondInterval);

    cleanupStartupTimers();

    expect(clearIntervalSpy).toHaveBeenCalledWith(secondInterval);
  });

  it("does not recreate monitor setup timers from stale invalidation listeners after stop", async () => {
    const boardEvents = createBoardEvents();
    const monitorSetup = createMonitorSetup({
      sessionManager: {} as never,
      boardEvents,
      serverPort: 4123,
      reviewSessionIds: new Set<string>(),
    });

    monitorSetup.stop();
    await Promise.resolve();
    await Promise.resolve();

    expect(vi.getTimerCount()).toBe(0);

    boardEvents.broadcast("project-1", "issue_updated");

    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let a stale monitor-butler preference sync recreate timers after stop", async () => {
    vi.mocked(getPreference).mockImplementation(async (key: string) =>
      key === "monitor_butler_enabled" ? "true" : "1",
    );

    startMonitorButler();
    stopMonitorButler();
    await Promise.resolve();
    await Promise.resolve();

    expect(vi.getTimerCount()).toBe(0);
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
