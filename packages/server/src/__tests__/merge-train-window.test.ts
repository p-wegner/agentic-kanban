import { describe, expect, it } from "vitest";
import {
  decideMergeTrainRelease,
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
});
