// #416: cross-cycle project scheduling — carry-over cursor + activity-based skip.
//
// The measured failure: at 10 monitor-driven projects one cycle's candidate walk exceeded
// the 4-min interval, so every cycle restarted at project #1, did all 10 again, and the
// board never had an idle moment. The scheduler makes a budget-stopped cycle's tail the
// next cycle's head (coverage converges across cycles) and skips projects with no board
// activity since their last completed sub-pass, with a slow safety-net floor.

import { describe, expect, it } from "vitest";
import {
  createMonitorProjectScheduler,
  DEFAULT_MONITOR_PROJECT_SLOW_FLOOR_MS,
} from "../startup/monitor-project-scheduler.js";

function makeClock(startMs = 0) {
  let t = startMs;
  return { now: () => t, advance: (ms: number) => { t += ms; }, set: (ms: number) => { t = ms; } };
}

describe("monitor project scheduler (#416)", () => {
  it("runs every project on the first plan (nothing has ever completed)", () => {
    const clock = makeClock();
    const scheduler = createMonitorProjectScheduler({ now: clock.now });
    const plan = scheduler.planCycle(["a", "b", "c"]);
    expect(plan.toRun).toEqual(["a", "b", "c"]);
    expect(plan.skipped).toEqual([]);
  });

  it("resumes at the carry-over cursor: the first NOT-completed project leads the next plan", () => {
    const clock = makeClock();
    const scheduler = createMonitorProjectScheduler({ now: clock.now });
    const plan1 = scheduler.planCycle(["a", "b", "c"]);
    // Budget stopped the cycle after `a`: b and c never completed.
    scheduler.recordCycleResult({ planned: plan1.toRun, completed: ["a"] });
    clock.advance(1000);

    const plan2 = scheduler.planCycle(["a", "b", "c"]);
    // Rotated to start at the cursor (b), and b/c are forced due (pending resume).
    expect(plan2.toRun).toEqual(["b", "c"]);
    // `a` completed with no activity since and the floor is not due — cheap skip.
    expect(plan2.skipped).toEqual(["a"]);
  });

  it("covers ALL projects across two budget-stopped cycles", () => {
    const clock = makeClock();
    const scheduler = createMonitorProjectScheduler({ now: clock.now });
    const covered = new Set<string>();

    const plan1 = scheduler.planCycle(["a", "b", "c", "d"]);
    // Cycle 1's budget allowed only the first two sub-passes.
    const done1 = plan1.toRun.slice(0, 2);
    done1.forEach((id) => covered.add(id));
    scheduler.recordCycleResult({ planned: plan1.toRun, completed: done1 });
    clock.advance(1000);

    const plan2 = scheduler.planCycle(["a", "b", "c", "d"]);
    plan2.toRun.forEach((id) => covered.add(id));
    scheduler.recordCycleResult({ planned: plan2.toRun, completed: plan2.toRun });

    expect(covered).toEqual(new Set(["a", "b", "c", "d"]));
    // And cycle 2 did NOT redo the projects cycle 1 already finished.
    expect(plan2.toRun).toEqual(["c", "d"]);
  });

  it("skips an inactive project but runs one with activity since its last sub-pass", () => {
    const clock = makeClock();
    const scheduler = createMonitorProjectScheduler({ now: clock.now });
    const plan1 = scheduler.planCycle(["quiet", "busy"]);
    scheduler.recordCycleResult({ planned: plan1.toRun, completed: plan1.toRun });

    clock.advance(60_000);
    scheduler.recordActivity("busy");
    clock.advance(1000);

    const plan2 = scheduler.planCycle(["quiet", "busy"]);
    expect(plan2.toRun).toEqual(["busy"]);
    expect(plan2.skipped).toEqual(["quiet"]);
  });

  it("activity that predates the completion stamp is consumed (the walk's own broadcasts do not keep a project hot)", () => {
    const clock = makeClock();
    const scheduler = createMonitorProjectScheduler({ now: clock.now });
    const plan1 = scheduler.planCycle(["a"]);
    // Broadcast DURING the walk (e.g. the monitor's own board_changed) …
    scheduler.recordActivity("a");
    clock.advance(1); // … then the sub-pass completes, stamping a LATER time.
    scheduler.recordCycleResult({ planned: plan1.toRun, completed: ["a"] });
    clock.advance(1000);
    expect(scheduler.planCycle(["a"]).skipped).toEqual(["a"]);
  });

  it("the slow floor forces a pass on an inactive project after the floor interval", () => {
    const clock = makeClock();
    const scheduler = createMonitorProjectScheduler({ now: clock.now });
    const plan1 = scheduler.planCycle(["a"]);
    scheduler.recordCycleResult({ planned: plan1.toRun, completed: ["a"] });

    clock.advance(DEFAULT_MONITOR_PROJECT_SLOW_FLOOR_MS - 1);
    expect(scheduler.planCycle(["a"]).skipped).toEqual(["a"]);

    clock.advance(1);
    expect(scheduler.planCycle(["a"]).toRun).toEqual(["a"]);
  });

  it("a #208-deferred (started but truncated) project is due next cycle even without activity", () => {
    const clock = makeClock();
    const scheduler = createMonitorProjectScheduler({ now: clock.now });
    // First give it a completion stamp so only pending-resume can make it due.
    const p0 = scheduler.planCycle(["a"]);
    scheduler.recordCycleResult({ planned: p0.toRun, completed: ["a"] });
    clock.advance(10); // activity must land STRICTLY AFTER the completion stamp to count
    scheduler.recordActivity("a");
    clock.advance(10);
    const p1 = scheduler.planCycle(["a"]);
    expect(p1.toRun).toEqual(["a"]);
    // Its walk started but hit the per-project budget → not completed.
    scheduler.recordCycleResult({ planned: p1.toRun, completed: [] });
    clock.advance(10);
    expect(scheduler.planCycle(["a"]).toRun).toEqual(["a"]);
  });

  it("a vanished cursor project (removed between cycles) does not break planning", () => {
    const clock = makeClock();
    const scheduler = createMonitorProjectScheduler({ now: clock.now });
    const plan1 = scheduler.planCycle(["a", "b"]);
    scheduler.recordCycleResult({ planned: plan1.toRun, completed: ["a"] }); // cursor = b
    clock.advance(10);
    const plan2 = scheduler.planCycle(["a", "c"]); // b is gone
    expect(plan2.toRun).toContain("c");
  });
});
