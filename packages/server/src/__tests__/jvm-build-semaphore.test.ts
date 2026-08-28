import { describe, it, expect, afterEach } from "vitest";
import { runUnderBuildSemaphore, buildSemaphoreConcurrency, buildSemaphoreActive } from "../services/jvm-build-semaphore.js";

afterEach(() => {
  delete process.env.KANBAN_VERIFY_CONCURRENCY;
});

describe("jvm-build-semaphore (#823, derived from capacity since #909)", () => {
  it("honors KANBAN_VERIFY_CONCURRENCY as an unconditional override", () => {
    process.env.KANBAN_VERIFY_CONCURRENCY = "5";
    expect(buildSemaphoreConcurrency()).toBe(5);
  });

  it("derives a positive width from live capacity when no override is set", () => {
    delete process.env.KANBAN_VERIFY_CONCURRENCY;
    expect(buildSemaphoreConcurrency()).toBeGreaterThanOrEqual(1);
  });

  it("an invalid override (0) falls through to the derived value, not a fixed constant", () => {
    process.env.KANBAN_VERIFY_CONCURRENCY = "0"; // invalid → derive instead
    expect(buildSemaphoreConcurrency()).toBeGreaterThanOrEqual(1);
  });

  it("never runs more than the cap concurrently; the rest queue FIFO", async () => {
    process.env.KANBAN_VERIFY_CONCURRENCY = "2";
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    // 4 tasks; first 2 should run immediately, 3rd/4th queue. Hold all open until we release.
    const tasks = [0, 1, 2, 3].map((i) =>
      runUnderBuildSemaphore(async () => {
        running++;
        peak = Math.max(peak, running);
        order.push(i);
        await gate; // hold the slot open
        running--;
        return i;
      }),
    );

    // Let the microtasks settle: exactly 2 should be running, 2 queued.
    await new Promise((r) => setTimeout(r, 20));
    expect(running).toBe(2);
    expect(peak).toBe(2);
    expect(buildSemaphoreActive()).toBe(2);
    expect(order).toEqual([0, 1]); // only the first two started

    release();
    const results = await Promise.all(tasks);
    expect(results).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2); // never exceeded the cap
    expect(buildSemaphoreActive()).toBe(0); // all slots released
  });

  it("releases the slot even when a task throws (no leak)", async () => {
    process.env.KANBAN_VERIFY_CONCURRENCY = "1";
    await expect(runUnderBuildSemaphore(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(buildSemaphoreActive()).toBe(0);
    // The next task can still acquire the (released) slot.
    await expect(runUnderBuildSemaphore(async () => "ok")).resolves.toBe("ok");
  });
});
