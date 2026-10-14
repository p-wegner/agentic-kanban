import { afterEach, describe, expect, it, vi } from "vitest";
import { clearHeldReprobe, holdReprobe, listHeldReprobes } from "../services/base-branch-reprobe-hold.js";

describe("held reprobe (#1471)", () => {
  afterEach(() => {
    clearHeldReprobe("p1", null);
    vi.useRealTimers();
  });

  it("is listed while held and retried until placement stops holding", async () => {
    vi.useFakeTimers();
    const reasons: Array<string | null> = ["no allowlisted worker with a free verify slot", null];
    const retry = vi.fn(async () => reasons.shift() ?? null);
    const held = holdReprobe({ projectId: "p1", branch: null, reason: "no allowlisted worker with a free verify slot", retry, retryDelayMs: 1000 });
    expect(held.reason).toContain("free verify slot");
    expect(listHeldReprobes("p1")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(listHeldReprobes("p1")).toHaveLength(1); // still held, re-armed

    await vi.advanceTimersByTimeAsync(1000);
    expect(retry).toHaveBeenCalledTimes(2);
    expect(listHeldReprobes("p1")).toHaveLength(0); // placed
  });

  it("a second hold for the same lane replaces the first and keeps heldSince", async () => {
    vi.useFakeTimers();
    const first = vi.fn(async () => "x");
    const second = vi.fn(async () => null);
    const a = holdReprobe({ projectId: "p1", branch: null, reason: "x", retry: first, retryDelayMs: 1000 });
    holdReprobe({ projectId: "p1", branch: null, reason: "x", retry: second, retryDelayMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(a.heldSince).toBeTruthy();
  });
});
