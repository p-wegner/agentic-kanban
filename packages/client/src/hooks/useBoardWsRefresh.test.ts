import { describe, it, expect, vi } from "vitest";
import { createBoardWsRefreshController } from "./useBoardWsRefresh.js";
import type { BoardWsEventDetail } from "../lib/useBoardEvents.js";

/** Deterministic timers — this package has no DOM renderer (cf. ButlerQuestionCard.test.tsx). */
function fakeTimers() {
  let next = 1;
  const pending = new Map<number, () => void>();
  return {
    timers: {
      setTimeout: (fn: () => void, _ms: number) => {
        const id = next++;
        pending.set(id, fn);
        return id;
      },
      clearTimeout: (id: number) => {
        pending.delete(id);
      },
    },
    /** Fire every armed timer once, in insertion order. */
    flush() {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, fn] of due) fn();
    },
    get armed() {
      return pending.size;
    },
  };
}

const detail = (projectId: string, reason: string): BoardWsEventDetail =>
  ({ projectId, reason }) as BoardWsEventDetail;

const ALL = () => true;

describe("createBoardWsRefreshController (#514)", () => {
  it("coalesces a burst into ONE refresh", () => {
    const t = fakeTimers();
    const refresh = vi.fn();
    const c = createBoardWsRefreshController({ projectId: "p1", shouldRefetch: ALL, refresh }, t.timers);
    c.handleEvent(detail("p1", "a"));
    c.handleEvent(detail("p1", "b"));
    c.handleEvent(detail("p1", "c"));
    expect(refresh).not.toHaveBeenCalled();
    expect(t.armed).toBe(1); // earlier timers cleared, not stacked
    t.flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("ignores events for another project", () => {
    const t = fakeTimers();
    const refresh = vi.fn();
    const c = createBoardWsRefreshController({ projectId: "p1", shouldRefetch: ALL, refresh }, t.timers);
    expect(c.handleEvent(detail("p2", "a"))).toBe(false);
    t.flush();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("honours the panel's reason predicate", () => {
    const t = fakeTimers();
    const refresh = vi.fn();
    const c = createBoardWsRefreshController(
      { projectId: "p1", shouldRefetch: (r) => (r as string) === "wanted", refresh },
      t.timers,
    );
    expect(c.handleEvent(detail("p1", "unwanted"))).toBe(false);
    expect(c.handleEvent(detail("p1", "wanted"))).toBe(true);
    t.flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not fire a pending refresh after dispose", () => {
    // Several copies never cleared the timer on unmount, so a late timer fetched into an
    // unmounted component.
    const t = fakeTimers();
    const refresh = vi.fn();
    const c = createBoardWsRefreshController({ projectId: "p1", shouldRefetch: ALL, refresh }, t.timers);
    c.handleEvent(detail("p1", "a"));
    c.dispose();
    t.flush();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("dispose() is idempotent and ignores later events", () => {
    const t = fakeTimers();
    const refresh = vi.fn();
    const c = createBoardWsRefreshController({ projectId: "p1", shouldRefetch: ALL, refresh }, t.timers);
    c.dispose();
    expect(() => c.dispose()).not.toThrow();
    expect(c.handleEvent(detail("p1", "a"))).toBe(false);
  });

  it("does not stack overlapping refreshes — it re-arms once instead", async () => {
    // One copy re-armed while a fetch was in flight, so a burst stacked overlapping
    // requests whose responses raced on shared refs.
    const t = fakeTimers();
    let resolveFirst: () => void = () => {};
    const refresh = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((r) => { resolveFirst = r; }))
      .mockImplementation(() => Promise.resolve());

    const c = createBoardWsRefreshController({ projectId: "p1", shouldRefetch: ALL, refresh }, t.timers);
    c.handleEvent(detail("p1", "a"));
    t.flush();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1); // in flight

    c.handleEvent(detail("p1", "b"));
    t.flush();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1); // NOT stacked

    resolveFirst();
    await new Promise((r) => setTimeout(r, 0));
    t.flush(); // the re-armed timer
    await new Promise((r) => setTimeout(r, 0));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("a rejected refresh does not escape as an unhandled rejection", async () => {
    const t = fakeTimers();
    const refresh = vi.fn().mockRejectedValue(new Error("boom"));
    const c = createBoardWsRefreshController({ projectId: "p1", shouldRefetch: ALL, refresh }, t.timers);
    c.handleEvent(detail("p1", "a"));
    expect(() => t.flush()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("is inert without a projectId", () => {
    const t = fakeTimers();
    const refresh = vi.fn();
    const c = createBoardWsRefreshController({ projectId: null, shouldRefetch: ALL, refresh }, t.timers);
    expect(c.handleEvent(detail("p1", "a"))).toBe(false);
    t.flush();
    expect(refresh).not.toHaveBeenCalled();
  });
});
