import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupStartupTimers, replaceStartupTimerCleanup } from "../startup/startup-timer-registry.js";

/**
 * Characterization tests for the timer-cleanup registry extracted out of
 * server-start.ts (#873). Pins the exact behaviour a `startServer()` restart
 * (tsx hot-reload) relies on: replacing the registered cleanup runs the
 * PREVIOUS one first, callbacks run in REVERSE registration order, and a
 * no-op registry doesn't throw when torn down.
 */
describe("startup-timer-registry", () => {
  afterEach(() => {
    cleanupStartupTimers();
  });

  it("cleanupStartupTimers is a no-op when nothing was ever registered", () => {
    expect(() => cleanupStartupTimers()).not.toThrow();
  });

  it("runs registered callbacks in reverse order on cleanup", () => {
    const order: number[] = [];
    replaceStartupTimerCleanup([
      () => order.push(1),
      () => order.push(2),
      () => order.push(3),
    ]);

    cleanupStartupTimers();

    expect(order).toEqual([3, 2, 1]);
  });

  it("cleanup only runs once even if called twice", () => {
    const cleanup = vi.fn();
    replaceStartupTimerCleanup([cleanup]);

    cleanupStartupTimers();
    cleanupStartupTimers();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("replacing the registry tears down the previous one first", () => {
    const first = vi.fn();
    const second = vi.fn();

    replaceStartupTimerCleanup([first]);
    replaceStartupTimerCleanup([second]);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    cleanupStartupTimers();

    expect(second).toHaveBeenCalledTimes(1);
  });
});
