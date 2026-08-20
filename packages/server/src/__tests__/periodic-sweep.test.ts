// @gate:always-run — pins the scheduler every background reconciler depends on (#529).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startPeriodicSweep } from "../lib/periodic-sweep.js";

describe("startPeriodicSweep (#529)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs once after the boot delay, then on the interval", () => {
    const tick = vi.fn();
    const h = startPeriodicSweep({ name: "t", intervalMs: 1000, bootDelayMs: 100, tick });
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(tick).toHaveBeenCalledTimes(1); // crash-recovery run
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(2);
    h.stop();
  });

  it("skips the boot run when bootDelayMs is null", () => {
    const tick = vi.fn();
    const h = startPeriodicSweep({ name: "t", intervalMs: 1000, bootDelayMs: null, tick });
    vi.advanceTimersByTime(999);
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it("stop() cancels BOTH the pending boot run and the interval", () => {
    // The `if (timer) return` variants only ever tracked the interval, so a stop()
    // between boot and first interval left the boot run armed.
    const tick = vi.fn();
    const h = startPeriodicSweep({ name: "t", intervalMs: 1000, bootDelayMs: 100, tick });
    h.stop();
    vi.advanceTimersByTime(10_000);
    expect(tick).not.toHaveBeenCalled();
  });

  it("stop() is idempotent", () => {
    const h = startPeriodicSweep({ name: "t", intervalMs: 1000, tick: vi.fn() });
    h.stop();
    expect(() => h.stop()).not.toThrow();
  });

  it("a rejected async tick is logged, not thrown, and the sweep keeps running", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tick = vi.fn().mockRejectedValue(new Error("boom"));
    const h = startPeriodicSweep({ name: "sweepy", intervalMs: 1000, bootDelayMs: 10, tick });
    vi.advanceTimersByTime(10);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(warn.mock.calls[0][0]).toContain("[sweepy]");
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(2); // survived the rejection
    h.stop();
    warn.mockRestore();
  });

  it("a SYNCHRONOUS throw in the tick is caught too", () => {
    // A sync throw escapes into the timer callback and becomes an unhandled
    // exception — none of the twelve hand-rolled copies guarded this.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tick = vi.fn(() => { throw new Error("sync boom"); });
    const h = startPeriodicSweep({ name: "sync", intervalMs: 1000, bootDelayMs: 10, tick });
    expect(() => vi.advanceTimersByTime(10)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    h.stop();
    warn.mockRestore();
  });
});
