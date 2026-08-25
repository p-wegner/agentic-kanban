import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupScheduledTasks } from "../startup/scheduled-tasks.js";
import { startAutoMergeOrchestrator } from "../startup/auto-merge-orchestrator.js";
import { startAncestorBranchReconciler, stopAncestorBranchReconciler } from "../startup/ancestor-branch-reconciler.js";
import type { AncestorBranchReconcilerDeps } from "../startup/ancestor-branch-reconciler.js";
import type { StrandedReviewReconcilerDeps } from "../startup/stranded-review-reconciler.js";
import type { ZombieFixSessionReconcilerDeps } from "../startup/zombie-fix-session-reconciler.js";
import type { Database } from "../db/index.js";
import { startDoneUnmergedSweep, stopDoneUnmergedSweep } from "../startup/done-unmerged-invariant-sweep.js";
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
  getAllPreferencesCached: vi.fn(async () => []),
}));

vi.mock("../db/index.js", () => {
  // Full drizzle-style chain resolving []. The old `{from: () => Promise.resolve([])}`
  // stub had no `.innerJoin`/`.where`, so the ancestor-branch reconciler's REAL
  // fire-and-forget tick (driven by the #151 test) threw
  // `database.select(...).from(...).innerJoin is not a function` AFTER its test
  // completed — an Unhandled Rejection that failed whole gate runs whose every test
  // passed, and (being a "crash") disqualified the #894 flake retry. See #921.
  const chain: Record<string, unknown> = {};
  for (const fn of ["from", "innerJoin", "leftJoin", "where", "orderBy", "groupBy"]) {
    chain[fn] = () => chain;
  }
  chain.limit = () => Promise.resolve([]);
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve([]).then(resolve, reject);
  chain.catch = (fn: (e: unknown) => unknown) => Promise.resolve([]).catch(fn);
  return { db: { select: () => chain } };
});

// Every export the module has, not just the one this test drives: the mock replaces the
// WHOLE module, so an unmocked export is a hard load error for any importer in the graph
// (here `workspace-launch-failures.service.ts` → `routes/project-analytics.ts`), which
// fails the suite before a single test runs.
vi.mock("../services/dirty-main-checkout.js", () => ({
  resetMissingRepoScanCounts: vi.fn(),
  getDirtyTrackedSourceFiles: vi.fn(() => Promise.resolve([])),
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

// vi.mock factories are hoisted above top-level const declarations, so the mock fn
// referenced inside must itself be declared via vi.hoisted() to avoid a TDZ error.
const { reconcileStrandedSiblingMergesMock } = vi.hoisted(() => ({
  reconcileStrandedSiblingMergesMock: vi.fn(() => Promise.resolve({ landed: 0, preserved: 0 })),
}));
vi.mock("../startup/merge-workflow.js", () => ({
  reconcileStrandedSiblingMerges: reconcileStrandedSiblingMergesMock,
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
    reconcileStrandedSiblingMergesMock.mockClear();
  });

  afterEach(() => {
    cleanupStartupTimers();
    stopMonitorButler();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("recreates scheduled-tasks timers instead of accumulating handles", () => {
    const runScheduledRun = vi.fn(async () => ({}));
    const first = setupScheduledTasks({ runScheduledRun });
    const second = setupScheduledTasks({ runScheduledRun });

    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(first.timer).not.toBe(second.timer);
    expect(first.interval).not.toBe(second.interval);
  });

  it("recreates ancestor-branch reconciler timers instead of accumulating handles", () => {
    const first = startAncestorBranchReconciler({}, 10_000);
    const second = startAncestorBranchReconciler({}, 10_000);

    // #529: these now return a PeriodicSweepHandle. The assertion is unchanged in
    // INTENT — a restart clears the previous pair and installs a new one — but the
    // handle no longer exposes the boot `timer`, which was an implementation detail.
    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(first).not.toBe(second);
    expect(first.interval).not.toBe(second.interval);
  });

  it("recreates done-unmerged scanner timers instead of accumulating handles", () => {
    const first = startDoneUnmergedSweep({}, 10_000);
    const second = startDoneUnmergedSweep({}, 10_000);

    // #529: these now return a PeriodicSweepHandle. The assertion is unchanged in
    // INTENT — a restart clears the previous pair and installs a new one — but the
    // handle no longer exposes the boot `timer`, which was an implementation detail.
    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(first).not.toBe(second);
    expect(first.interval).not.toBe(second.interval);
  });

  it("clears ancestor-branch reconciler interval handles on stop", () => {
    const { interval } = startAncestorBranchReconciler({}, 10_000);

    stopAncestorBranchReconciler();

    // The boot timeout is cleared too; its handle is private to the sweep now, so this
    // asserts it happened rather than which object it was called with. NOT a count
    // assertion: the previous test leaves a live sweep, which this test's own start()
    // clears first — the original `toHaveBeenCalledWith(timer)` was count-agnostic too.
    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(clearIntervalSpy).toHaveBeenCalledWith(interval);
  });

  it("clears done-unmerged scanner interval handles on stop", () => {
    const { interval } = startDoneUnmergedSweep({}, 10_000);

    stopDoneUnmergedSweep();

    // The boot timeout is cleared too; its handle is private to the sweep now, so this
    // asserts it happened rather than which object it was called with. NOT a count
    // assertion: the previous test leaves a live sweep, which this test's own start()
    // clears first — the original `toHaveBeenCalledWith(timer)` was count-agnostic too.
    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(clearIntervalSpy).toHaveBeenCalledWith(interval);
  });

  it("ancestor-branch reconciler stops firing ticks after cleanup", () => {
    const tick = vi.fn();
    startAncestorBranchReconciler({ onTick: tick }, 5_000);
    stopAncestorBranchReconciler();

    vi.advanceTimersByTime(60_000);

    expect(tick).not.toHaveBeenCalled();
  });

  it("ancestor-branch reconciler's default tick also runs the stranded-sibling compensator on the same cadence (#151)", async () => {
    // Long interval (100s) so the initial 35s boot timeout and the recurring interval
    // fire at clearly separate points instead of overlapping in the assertion window.
    const ancestorDeps: AncestorBranchReconcilerDeps = { enabled: false };
    startAncestorBranchReconciler(ancestorDeps, 100_000);

    await vi.advanceTimersByTimeAsync(35_000); // fires the initial boot timeout only
    expect(reconcileStrandedSiblingMergesMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100_000); // fires the recurring interval once
    expect(reconcileStrandedSiblingMergesMock).toHaveBeenCalledTimes(2);
  });

  it("stranded-sibling compensator does NOT run when a custom onTick is supplied (tick fully overridden)", async () => {
    const tick = vi.fn();
    startAncestorBranchReconciler({ onTick: tick }, 100_000);

    await vi.advanceTimersByTimeAsync(35_000);

    expect(tick).toHaveBeenCalledTimes(1);
    expect(reconcileStrandedSiblingMergesMock).not.toHaveBeenCalled();
  });

  it("done-unmerged scanner stops firing ticks after cleanup", () => {
    const tick = vi.fn();
    startDoneUnmergedSweep({ onTick: tick }, 5_000);
    stopDoneUnmergedSweep();

    vi.advanceTimersByTime(60_000);

    expect(tick).not.toHaveBeenCalled();
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
      fixAndMergeSessionIds: new Set<string>(),
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
      },
      getSessionManager: () => ({}),
    } as unknown as Parameters<typeof startAutoMergeOrchestrator>[0];
    const first = startAutoMergeOrchestrator(deps);
    const second = startAutoMergeOrchestrator(deps);

    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(first.timer).not.toBe(second.timer);
  });

  it("recreates stranded-review reconciler timer instead of accumulating handles", () => {
    // These lifecycle tests never let a tick run, so the collaborators are stubs.
    const deps = {
      database: {},
      getSessionManager: () => ({}),
      boardEvents: { broadcast: vi.fn() },
      reviewSessionIds: new Set<string>(),
    } as unknown as StrandedReviewReconcilerDeps;
    const first = startStrandedReviewReconciler(deps, 60_000);
    const second = startStrandedReviewReconciler(deps, 60_000);

    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
    expect(first).not.toBe(second);
  });

  it("recreates zombie-fix reconciler timer instead of accumulating handles", () => {
    const deps = {
      boardEvents: { broadcast: vi.fn(), broadcastActivity: vi.fn() },
      database: {},
    } as unknown as ZombieFixSessionReconcilerDeps;
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
    startSessionMessagePruner({} as unknown as Database);
    startSessionMessagePruner({} as unknown as Database);

    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();
  });
});
