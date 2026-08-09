import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_WINDOW_KEYS,
  openOperationWindow,
  openWindowCountForTest,
  topWindowOperations,
} from "../src/lib/operation-windows.js";
import { recordOperation, resetOperationsForTest } from "../src/lib/operation-metrics.js";

/**
 * #359 (second round) — the two numbers a cumulative counter cannot produce, and which the first
 * round of this ticket needed and did without:
 *
 *  - a TRUE per-window `maxMs` (a max is not differenceable, so the snapshot-diff reported 0 for
 *    every window after the first slow one — every one of ~40 operation records in a reported cycle
 *    read `maxMs: 0`, and that is the number that would confirm or kill a tail-latency story), and
 *  - `duplicateCalls`: how many spawns in the window repeated one already made, i.e. the ceiling on
 *    what a window-scoped memo could remove. #359's recommended fix (memoize per-cycle `rev-parse`)
 *    rested on an unmeasured guess at that ceiling; it is now a counter instead of an argument.
 */
afterEach(() => resetOperationsForTest());

describe("openOperationWindow", () => {
  it("reports a true max for the window, not a global high-water mark", () => {
    recordOperation("git:rev-parse", 9_000);
    const window = openOperationWindow();
    recordOperation("git:rev-parse", 40);
    expect(window.close()["git:rev-parse"]).toMatchObject({ calls: 1, totalMs: 40, maxMs: 40 });
  });

  it("counts a repeated (cwd, argv) as a duplicate — the memoization ceiling", () => {
    const window = openOperationWindow();
    recordOperation("git:rev-parse", 10, false, "C:\\repo rev-parse master");
    recordOperation("git:rev-parse", 10, false, "C:\\repo rev-parse master");
    recordOperation("git:rev-parse", 10, false, "C:\\repo rev-parse HEAD");
    const stat = window.close()["git:rev-parse"];
    expect(stat).toMatchObject({ calls: 3, keyedCalls: 3, duplicateCalls: 1 });
  });

  it("never counts an operation without a call identity as a duplicate", () => {
    // Two preference reads are not repeats of each other just because both were reads.
    const window = openOperationWindow();
    recordOperation("db:getPreference", 1);
    recordOperation("db:getPreference", 1);
    expect(window.close()["db:getPreference"]).toMatchObject({ calls: 2, keyedCalls: 0, duplicateCalls: 0 });
  });

  it("keeps the same key distinct per label", () => {
    const window = openOperationWindow();
    recordOperation("git:rev-parse", 5, false, "C:\\repo x");
    recordOperation("git:rev-list", 5, false, "C:\\repo x");
    const report = window.close();
    expect(report["git:rev-parse"].duplicateCalls).toBe(0);
    expect(report["git:rev-list"].duplicateCalls).toBe(0);
  });

  it("gives nested windows independent duplicate sets", () => {
    // The monitor nests a phase window inside a cycle window: "repeated in this phase" and
    // "repeated anywhere in this cycle" are different questions and must not share a set.
    const cycle = openOperationWindow();
    const phaseA = openOperationWindow();
    recordOperation("git:rev-parse", 5, false, "C:\\repo rev-parse master");
    phaseA.close();
    const phaseB = openOperationWindow();
    recordOperation("git:rev-parse", 5, false, "C:\\repo rev-parse master");
    expect(phaseB.close()["git:rev-parse"].duplicateCalls).toBe(0);
    expect(cycle.close()["git:rev-parse"].duplicateCalls).toBe(1);
  });

  it("separates blocking time from wall clock", () => {
    const window = openOperationWindow();
    recordOperation("git:status", 100, true);
    recordOperation("git:status", 100, false);
    expect(window.close()["git:status"]).toMatchObject({ totalMs: 200, blockingMs: 100, blockingCalls: 1 });
  });

  it("stops tracking a closed window and leaves nothing open", () => {
    const window = openOperationWindow();
    recordOperation("git:status", 10);
    const report = window.close();
    recordOperation("git:status", 999);
    expect(openWindowCountForTest()).toBe(0);
    expect(report["git:status"].calls).toBe(1);
    // Closing twice reports the same window rather than an empty one.
    expect(window.close()["git:status"].calls).toBe(1);
  });

  it("stops counting duplicates past the key cap instead of growing without limit", () => {
    const window = openOperationWindow();
    for (let i = 0; i <= MAX_WINDOW_KEYS; i++) recordOperation("git:rev-parse", 1, false, `key-${i}`);
    // The last key was never remembered, so a repeat of it is not reported — bounded, not wrong
    // in the direction that would overstate what a memo could save.
    recordOperation("git:rev-parse", 1, false, `key-${MAX_WINDOW_KEYS}`);
    expect(window.close()["git:rev-parse"].duplicateCalls).toBe(0);
  });

  it("orders a report by total time, worst first", () => {
    const window = openOperationWindow();
    recordOperation("git:status", 100);
    recordOperation("git:rev-list", 900);
    expect(topWindowOperations(window.close(), 1).map((o) => o.label)).toEqual(["git:rev-list"]);
  });
});
