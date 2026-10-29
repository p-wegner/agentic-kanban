import { describe, expect, it } from "vitest";
import { decideInconclusiveRetry, INCONCLUSIVE_ABANDON_MARKER } from "../services/merge-queue-train-inconclusive.js";
import { decideMergeTrainRelease } from "../services/merge-train-window.js";

const NOW = Date.now();
const row = (ageMin: number) => ({
  id: `t${ageMin}`,
  state: "abandoned",
  reconciledReason: `${INCONCLUSIVE_ABANDON_MARKER}: x`,
  memberWorkspaceIds: JSON.stringify(["a", "b"]),
  startedAt: new Date(NOW - (ageMin + 5) * 60_000).toISOString(),
  finishedAt: new Date(NOW - ageMin * 60_000).toISOString(),
});
const state = { pendingIds: ["a", "b"], firstSeenAt: new Date(NOW - 3_600_000).toISOString() };
const config = { maxSize: 4, maxWaitMs: 600_000 };

describe("decideInconclusiveRetry (#1741)", () => {
  it("first inconclusive abandon retries at once", () => {
    expect(decideInconclusiveRetry(["a"], [row(1)], NOW)).toEqual({ kind: "retry" });
  });
  it("second waits the 15 min ramp, then retries", () => {
    expect(decideInconclusiveRetry(["a"], [row(1), row(10)], NOW).kind).toBe("backoff");
    expect(decideInconclusiveRetry(["a"], [row(16), row(30)], NOW).kind).toBe("retry");
  });
  it("three in a row is a hold, not inconclusive_retry", () => {
    const d = decideInconclusiveRetry(["a", "b"], [row(1), row(10), row(20)], NOW);
    expect(d.kind).toBe("backoff");
    const v = decideMergeTrainRelease(state, config, NOW, { inconclusiveRetry: d.kind === "retry", inconclusiveHold: "inconclusive_backoff" });
    expect(v).toEqual({ release: false, reason: "inconclusive_backoff" });
  });
  it("past the ceiling is exhausted; a changed member set resets", () => {
    const rows = [row(1), row(2), row(3), row(4), row(5)];
    expect(decideInconclusiveRetry(["a"], rows, NOW).kind).toBe("exhausted");
    expect(decideInconclusiveRetry(["a", "z"], rows, NOW).kind).toBe("none");
  });
  it("operator release still wins over the hold", () => {
    expect(decideMergeTrainRelease(state, config, NOW, { releaseRequested: true, inconclusiveHold: "inconclusive_exhausted" }))
      .toEqual({ release: true, reason: "operator_release" });
  });
});
