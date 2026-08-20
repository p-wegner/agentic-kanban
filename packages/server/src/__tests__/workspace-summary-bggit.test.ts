import { describe, expect, it, vi } from "vitest";
import { runBgGit } from "../services/workspace-summary.service.js";

/**
 * #398 — runBgGit used to be drop-over-cap: with 5 tasks running, the 6th+ scheduled
 * refresh was SILENTLY discarded, so the workspace-summary cache never warmed past the
 * 5th workspace. It now queues over-cap work; dropping is reserved for a pathological
 * queue bound and logged. These tests lock: bounded concurrency, no silent drops, and
 * a rejecting task not wedging the lane.
 *
 * Note: tests in this file share the module-global lane, so each test drains fully.
 */

function deferredTask(started: number[], id: number, gates: Array<() => void>): () => Promise<void> {
  return () =>
    new Promise<void>((resolve) => {
      started.push(id);
      gates.push(resolve);
    });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("runBgGit (#398 — queue, don't drop)", () => {
  it("runs at most 5 tasks concurrently but the 6th+ scheduled refresh STILL executes", async () => {
    const started: number[] = [];
    const gates: Array<() => void> = [];
    const total = 9;
    for (let i = 0; i < total; i++) runBgGit(deferredTask(started, i, gates));

    // Concurrency cap still holds…
    expect(started).toEqual([0, 1, 2, 3, 4]);

    // …but finishing tasks hands the lane to the queued ones instead of having dropped them.
    while (gates.length > 0 || started.length < total) {
      const gate = gates.shift();
      if (!gate) throw new Error("lane wedged: queued tasks never started");
      gate();
      await flush();
    }
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("a rejecting task releases its lane so queued work still runs", async () => {
    const started: number[] = [];
    const gates: Array<() => void> = [];
    const rejectors: Array<() => void> = [];
    // Occupy the lane with 5 failing tasks, then queue one good one.
    for (let i = 0; i < 5; i++) {
      runBgGit(() => new Promise<void>((_res, rej) => rejectors.push(() => rej(new Error("refresh failed")))));
    }
    runBgGit(deferredTask(started, 99, gates));
    expect(started).toEqual([]);

    for (const rej of rejectors) rej();
    await flush();
    expect(started).toEqual([99]); // the queued task ran despite every predecessor rejecting

    gates.shift()!();
    await flush();
  });

  it("drops only past the queue bound, and loudly", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const gates: Array<() => void> = [];
      let executed = 0;
      const blocker = () =>
        new Promise<void>((resolve) => {
          executed++;
          gates.push(resolve);
        });
      // 5 running + 1000 queued fills the bound; the next one is the logged exception.
      for (let i = 0; i < 5 + 1000; i++) runBgGit(blocker);
      expect(warn).not.toHaveBeenCalled();
      runBgGit(blocker);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("dropping a refresh task");

      // Drain so later tests (and the shared module state) start clean.
      while (gates.length > 0) {
        gates.shift()!();
        await flush();
      }
      expect(executed).toBe(5 + 1000);
    } finally {
      warn.mockRestore();
    }
  });
});
