import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startStaggeredPoll } from "../lib/pollScheduler.js";

// usePoll/useNow are thin wrappers over startStaggeredPoll; this package has neither
// @testing-library/react nor a DOM environment (no jsdom dependency — cf. Badge.test.tsx,
// which renders with react-dom/server instead). What is pinned here is the scheduler
// CONTRACT the hooks depend on: the two properties the six raw setInterval pollers were
// missing, and which a future edit to pollScheduler could silently drop.
//
// `document` is stubbed rather than the test skipped: the scheduler touches exactly
// `hidden`, `addEventListener` and `removeEventListener`, so a stub exercises the real
// branch instead of the `typeof document === "undefined"` fallback a bare node run takes.

interface DocStub {
  hidden: boolean;
  addEventListener: (type: string, fn: () => void) => void;
  removeEventListener: (type: string, fn: () => void) => void;
  fire: (type: string) => void;
}

function installDocumentStub(): DocStub {
  const listeners = new Map<string, Set<() => void>>();
  const stub: DocStub = {
    hidden: false,
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
    fire: (type) => listeners.get(type)?.forEach((fn) => fn()),
  };
  vi.stubGlobal("document", stub);
  return stub;
}

describe("startStaggeredPoll — the contract usePoll relies on (#518)", () => {
  let doc: DocStub;

  beforeEach(() => {
    vi.useFakeTimers();
    doc = installDocumentStub();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not fire immediately — the first tick is phase-offset", () => {
    const fn = vi.fn();
    const handle = startStaggeredPoll(fn, 1000);
    expect(fn).not.toHaveBeenCalled();
    // The offset floor is 25% of the interval, so nothing may fire before that. This is
    // what keeps independent pollers from phase-aligning at mount.
    vi.advanceTimersByTime(249);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalled();
    handle.stop();
  });

  it("skips ticks while the tab is hidden, then catches up once on becoming visible", () => {
    const fn = vi.fn();
    const handle = startStaggeredPoll(fn, 1000);

    doc.hidden = true;
    vi.advanceTimersByTime(5000);
    expect(fn, "a hidden tab must not poll").not.toHaveBeenCalled();

    doc.hidden = false;
    doc.fire("visibilitychange");
    expect(fn, "exactly one catch-up, not one per skipped tick").toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it("stop() is idempotent and silences all further ticks", () => {
    const fn = vi.fn();
    const handle = startStaggeredPoll(fn, 1000);
    handle.stop();
    handle.stop();
    vi.advanceTimersByTime(10_000);
    expect(fn).not.toHaveBeenCalled();
  });
});
