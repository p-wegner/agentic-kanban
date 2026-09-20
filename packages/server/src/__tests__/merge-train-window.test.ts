import { describe, expect, it } from "vitest";
import {
  decideMergeTrainRelease,
  decideWindowHold,
  DEFAULT_GATE_BUSY_GRACE_MS,
  DEFAULT_TRAIN_MAX_SIZE,
  DEFAULT_TRAIN_MAX_WAIT_MS,
  type MergeTrainWindowState,
} from "../services/merge-train-window.js";

const BASE_NOW_MS = new Date("2026-08-26T12:00:00.000Z").getTime();

function state(pendingIds: string[], firstSeenAt = new Date(BASE_NOW_MS).toISOString()): MergeTrainWindowState {
  return { pendingIds, firstSeenAt };
}

describe("decideMergeTrainRelease (#905)", () => {
  it("keeps accumulating below max size and before max wait", () => {
    const verdict = decideMergeTrainRelease(
      state(["a", "b"]),
      { maxSize: DEFAULT_TRAIN_MAX_SIZE, maxWaitMs: DEFAULT_TRAIN_MAX_WAIT_MS },
      BASE_NOW_MS + 1000,
    );
    expect(verdict).toEqual({ release: false, reason: "accumulating" });
  });

  it("releases once the pending set reaches max size", () => {
    const verdict = decideMergeTrainRelease(
      state(["a", "b", "c", "d"]),
      { maxSize: 4, maxWaitMs: DEFAULT_TRAIN_MAX_WAIT_MS },
      BASE_NOW_MS + 1000,
    );
    expect(verdict).toEqual({ release: true, reason: "max_size" });
  });

  it("does not release before max size even one short", () => {
    const verdict = decideMergeTrainRelease(
      state(["a", "b", "c"]),
      { maxSize: 4, maxWaitMs: DEFAULT_TRAIN_MAX_WAIT_MS },
      BASE_NOW_MS + 1000,
    );
    expect(verdict.release).toBe(false);
  });

  it("releases once the oldest pending member has waited past max wait, regardless of size", () => {
    const verdict = decideMergeTrainRelease(
      state(["a"], new Date(BASE_NOW_MS).toISOString()),
      { maxSize: 4, maxWaitMs: 5 * 60_000 },
      BASE_NOW_MS + 5 * 60_000 + 1,
    );
    expect(verdict).toEqual({ release: true, reason: "max_wait" });
  });

  it("does not release before max wait elapses", () => {
    const verdict = decideMergeTrainRelease(
      state(["a"], new Date(BASE_NOW_MS).toISOString()),
      { maxSize: 4, maxWaitMs: 5 * 60_000 },
      BASE_NOW_MS + 5 * 60_000 - 1,
    );
    expect(verdict.release).toBe(false);
  });

  it("max size wins even if max wait has not elapsed", () => {
    const verdict = decideMergeTrainRelease(
      state(["a", "b", "c", "d"], new Date(BASE_NOW_MS).toISOString()),
      { maxSize: 4, maxWaitMs: DEFAULT_TRAIN_MAX_WAIT_MS },
      BASE_NOW_MS + 1,
    );
    expect(verdict).toEqual({ release: true, reason: "max_size" });
  });

  describe("gate-busy grace (#1138)", () => {
    // The livelock this reproduces: `iterate`/`standard` postures set `trainMaxSize: 1`, so a
    // singleton ready workspace hits `max_size` on the very tick it appears. Releasing it
    // straight into an already-running verify chain doesn't merge it any sooner (one verify
    // slot, process-wide) — it only guarantees the #243 discard for whichever sibling gate
    // finishes next and finds the base moved. The grace holds a size-1 release for a short,
    // bounded window while a sibling gate is in flight, instead of firing it immediately.

    it("holds a max_size release when a verify chain is already running", () => {
      const verdict = decideMergeTrainRelease(
        state(["a"], new Date(BASE_NOW_MS).toISOString()),
        { maxSize: 1, maxWaitMs: 0 },
        BASE_NOW_MS + 1,
        { gateBusy: true },
      );
      expect(verdict).toEqual({ release: false, reason: "gate_busy" });
    });

    it("releases immediately when maxSize is reached and no gate is busy (unchanged default)", () => {
      const verdict = decideMergeTrainRelease(
        state(["a"], new Date(BASE_NOW_MS).toISOString()),
        { maxSize: 1, maxWaitMs: 0 },
        BASE_NOW_MS + 1,
        { gateBusy: false },
      );
      expect(verdict).toEqual({ release: true, reason: "max_size" });
    });

    it("releases once the gate-busy grace elapses, even though the gate is still busy", () => {
      const verdict = decideMergeTrainRelease(
        state(["a"], new Date(BASE_NOW_MS).toISOString()),
        { maxSize: 1, maxWaitMs: 0 },
        BASE_NOW_MS + DEFAULT_GATE_BUSY_GRACE_MS + 1,
        { gateBusy: true },
      );
      expect(verdict).toEqual({ release: true, reason: "gate_busy_grace_elapsed" });
    });

    it("respects an injected gateBusyGraceMs override", () => {
      const heldVerdict = decideMergeTrainRelease(
        state(["a"], new Date(BASE_NOW_MS).toISOString()),
        { maxSize: 1, maxWaitMs: 0 },
        BASE_NOW_MS + 500,
        { gateBusy: true, gateBusyGraceMs: 1000 },
      );
      expect(heldVerdict).toEqual({ release: false, reason: "gate_busy" });

      const releasedVerdict = decideMergeTrainRelease(
        state(["a"], new Date(BASE_NOW_MS).toISOString()),
        { maxSize: 1, maxWaitMs: 0 },
        BASE_NOW_MS + 1001,
        { gateBusy: true, gateBusyGraceMs: 1000 },
      );
      expect(releasedVerdict).toEqual({ release: true, reason: "gate_busy_grace_elapsed" });
    });

    it("does not apply the gate-busy hold to a max_wait release", () => {
      // A batch that has already waited past its own accumulation window must not be held
      // further just because a gate happens to be busy — max_wait is itself a starvation
      // escape and gate-busy holding on top of it would defeat that purpose.
      const verdict = decideMergeTrainRelease(
        state(["a"], new Date(BASE_NOW_MS).toISOString()),
        { maxSize: 4, maxWaitMs: 5 * 60_000 },
        BASE_NOW_MS + 5 * 60_000 + 1,
        { gateBusy: true },
      );
      expect(verdict).toEqual({ release: true, reason: "max_wait" });
    });

    it("defaults gateBusy to false when opts is omitted (existing callers unaffected)", () => {
      const verdict = decideMergeTrainRelease(
        state(["a"], new Date(BASE_NOW_MS).toISOString()),
        { maxSize: 1, maxWaitMs: 0 },
        BASE_NOW_MS + 1,
      );
      expect(verdict).toEqual({ release: true, reason: "max_size" });
    });
  });

  describe("operator controls (#1186)", () => {
    it("a live hold wins over max size", () => {
      const verdict = decideMergeTrainRelease(
        state(["a", "b", "c", "d"]),
        { maxSize: 4, maxWaitMs: DEFAULT_TRAIN_MAX_WAIT_MS },
        BASE_NOW_MS + 1000,
        { heldUntilMs: BASE_NOW_MS + 60_000 },
      );
      expect(verdict).toEqual({ release: false, reason: "held" });
    });

    it("a live hold wins over max wait", () => {
      const verdict = decideMergeTrainRelease(
        state(["a"]),
        { maxSize: 4, maxWaitMs: 60_000 },
        BASE_NOW_MS + 61_000,
        { heldUntilMs: BASE_NOW_MS + 120_000 },
      );
      expect(verdict).toEqual({ release: false, reason: "held" });
    });

    it("a live hold wins over a pending release request (the hold is the later, more conservative instruction)", () => {
      const verdict = decideMergeTrainRelease(
        state(["a"]),
        { maxSize: 4, maxWaitMs: DEFAULT_TRAIN_MAX_WAIT_MS },
        BASE_NOW_MS + 1000,
        { heldUntilMs: BASE_NOW_MS + 60_000, releaseRequested: true },
      );
      expect(verdict).toEqual({ release: false, reason: "held" });
    });

    it("an expired hold no longer holds", () => {
      const verdict = decideMergeTrainRelease(
        state(["a", "b", "c", "d"]),
        { maxSize: 4, maxWaitMs: DEFAULT_TRAIN_MAX_WAIT_MS },
        BASE_NOW_MS + 61_000,
        { heldUntilMs: BASE_NOW_MS + 60_000 },
      );
      expect(verdict).toEqual({ release: true, reason: "max_size" });
    });

    it("a release request departs a lone member below size and before wait, even with a busy gate", () => {
      const verdict = decideMergeTrainRelease(
        state(["a"]),
        { maxSize: 4, maxWaitMs: DEFAULT_TRAIN_MAX_WAIT_MS },
        BASE_NOW_MS + 1000,
        { releaseRequested: true, gateBusy: true },
      );
      expect(verdict).toEqual({ release: true, reason: "operator_release" });
    });

    it("a null heldUntilMs is the same as no hold", () => {
      const verdict = decideMergeTrainRelease(
        state(["a", "b", "c", "d"]),
        { maxSize: 4, maxWaitMs: DEFAULT_TRAIN_MAX_WAIT_MS },
        BASE_NOW_MS + 1000,
        { heldUntilMs: null },
      );
      expect(verdict).toEqual({ release: true, reason: "max_size" });
    });
  });
});


describe("decideWindowHold (#1211)", () => {
  const releasing = { release: true, reason: "max_size" } as const;
  const accumulating = { release: false, reason: "accumulating" } as const;

  it("breaker_paused beats everything — a paused project must not gate at all", () => {
    expect(decideWindowHold({ verdict: releasing, breakerPaused: true, baseRed: true }))
      .toEqual({ release: false, reason: "breaker_paused" });
    expect(decideWindowHold({ verdict: releasing, breakerPaused: true, baseRed: false }))
      .toEqual({ release: false, reason: "breaker_paused" });
  });

  it("base_red beats the release verdict, but loses to the breaker", () => {
    expect(decideWindowHold({ verdict: releasing, breakerPaused: false, baseRed: true }))
      .toEqual({ release: false, reason: "base_red" });
  });

  it("passes the size/wait/gate verdict through untouched when neither veto fires", () => {
    expect(decideWindowHold({ verdict: releasing, breakerPaused: false, baseRed: false })).toEqual(releasing);
    expect(decideWindowHold({ verdict: accumulating, breakerPaused: false, baseRed: false })).toEqual(accumulating);
    expect(decideWindowHold({ verdict: { release: false, reason: "gate_busy" }, breakerPaused: false, baseRed: false }))
      .toEqual({ release: false, reason: "gate_busy" });
    expect(decideWindowHold({ verdict: { release: true, reason: "max_wait" }, breakerPaused: false, baseRed: false }))
      .toEqual({ release: true, reason: "max_wait" });
    expect(decideWindowHold({ verdict: { release: true, reason: "operator_release" }, breakerPaused: false, baseRed: false }))
      .toEqual({ release: true, reason: "operator_release" });
    expect(decideWindowHold({ verdict: { release: false, reason: "held" }, breakerPaused: false, baseRed: false }))
      .toEqual({ release: false, reason: "held" });
  });

  it("holds a non-releasing verdict under a veto too — the reason is the veto, not the wait", () => {
    expect(decideWindowHold({ verdict: accumulating, breakerPaused: true, baseRed: false }))
      .toEqual({ release: false, reason: "breaker_paused" });
  });
});
