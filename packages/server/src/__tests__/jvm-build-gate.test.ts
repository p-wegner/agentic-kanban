import { describe, it, expect, afterEach } from "vitest";
import { runUnderBuildGate, buildGateConcurrency, buildGateActive } from "../services/jvm-build-gate.js";

afterEach(() => {
  delete process.env.KANBAN_VERIFY_CONCURRENCY;
});

describe("jvm-build-gate (#823)", () => {
  it("defaults to a concurrency of 2 and honors KANBAN_VERIFY_CONCURRENCY", () => {
    expect(buildGateConcurrency()).toBe(2);
    process.env.KANBAN_VERIFY_CONCURRENCY = "5";
    expect(buildGateConcurrency()).toBe(5);
    process.env.KANBAN_VERIFY_CONCURRENCY = "0"; // invalid → clamp to default
    expect(buildGateConcurrency()).toBe(2);
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
      runUnderBuildGate(async () => {
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
    expect(buildGateActive()).toBe(2);
    expect(order).toEqual([0, 1]); // only the first two started

    release();
    const results = await Promise.all(tasks);
    expect(results).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2); // never exceeded the cap
    expect(buildGateActive()).toBe(0); // all slots released
  });

  it("releases the slot even when a task throws (no leak)", async () => {
    process.env.KANBAN_VERIFY_CONCURRENCY = "1";
    await expect(runUnderBuildGate(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(buildGateActive()).toBe(0);
    // The next task can still acquire the (released) slot.
    await expect(runUnderBuildGate(async () => "ok")).resolves.toBe("ok");
  });
});
