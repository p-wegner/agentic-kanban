// #1344 — reconnect backoff stays low while the board was recently reachable.
import { describe, it, expect } from "vitest";
import { nextReconnectDelay, reconnectCapMs } from "../worker/worker-daemon.js";

describe("worker reconnect backoff cap (#1344)", () => {
  it("never exceeds 5s during the first window after the board was last reachable", () => {
    let current = 1000;
    let sinceReachable = 0;
    for (let i = 0; i < 30; i++) {
      const { delay, next } = nextReconnectDelay(current, sinceReachable);
      expect(delay).toBeLessThanOrEqual(5000);
      current = next;
      sinceReachable += delay + 6000; // delay plus a failed connect attempt
      if (sinceReachable >= 5 * 60 * 1000) break;
    }
  });

  it("grows toward the long cap once the window has passed or the board was never reachable", () => {
    expect(reconnectCapMs(6 * 60 * 1000)).toBe(30_000);
    expect(reconnectCapMs(null)).toBe(30_000);
    expect(nextReconnectDelay(16_000, null)).toEqual({ delay: 16_000, next: 30_000 });
  });

  it("clamps an already-grown delay when entering the recent window", () => {
    expect(nextReconnectDelay(30_000, 1000).delay).toBe(5000);
  });
});
