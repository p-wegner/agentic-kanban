import { describe, expect, it } from "vitest";
import { describeMergeJobBadge, isTerminalMergeStatus, mergeErrorFromStatus, type MergeStatusView } from "./mergeJobBadge.js";

const NOW = Date.parse("2026-09-24T12:10:00.000Z");
const iso = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();

/** A live `merge-status` body mid-gate, as `describeLiveMergeJob` answers it. */
const RUNNING: MergeStatusView = {
  job: {
    jobId: "merge-ws1-3",
    state: "running",
    startedAt: iso(600),
    attempts: [
      { attempt: 1, source: "pre-lock-merge", startedAt: iso(590), finishedAt: iso(300), outcome: "discarded", detail: "base moved" },
      { attempt: 2, source: "pre-lock-merge", startedAt: iso(290), phase: "verify", phaseSince: iso(192), phaseDetail: "test:mine, 3 file(s)" },
    ],
  },
  attemptSummary: "2 gate attempt(s). attempt 1 (pre-lock-merge): discarded …; attempt 2: IN FLIGHT",
  fixHint: null,
};

const FAILED: MergeStatusView = {
  job: {
    jobId: "merge-ws1-4",
    state: "failed",
    startedAt: iso(900),
    error: "pre-merge gate failed",
    attempts: [{ attempt: 1, source: "pre-lock-merge", startedAt: iso(890), finishedAt: iso(10), outcome: "failed", detail: "failing suite(s): packages/client/src/__tests__/function-nloc-ratchet.test.ts\n…\nstale baseline: lower a.tsx::A 416 -> 371 in packages/client/src/__tests__/function-nloc-baseline.ts" }],
  },
  fixHint: { kind: "bank-shrinks", summary: "stale baseline: lower a.tsx::A 416 -> 371 in packages/client/src/__tests__/function-nloc-baseline.ts", edits: [{ baselineFile: "packages/client/src/__tests__/function-nloc-baseline.ts", key: "a.tsx::A", from: 416, to: 371 }] },
};

describe("describeMergeJobBadge (#1250)", () => {
  it("names the in-flight phase, counts from phaseSince, and says which attempt", () => {
    const badge = describeMergeJobBadge(RUNNING, NOW);
    expect(badge?.label).toBe("Merging · verify · 3m · attempt 2");
    expect(badge?.title).toContain("test:mine, 3 file(s)");
    expect(badge?.title).toContain("2 gate attempt(s)");
  });

  it("falls back to the attempt start, then the job start, before phases are reported", () => {
    const noPhase: MergeStatusView = { job: { ...RUNNING.job!, attempts: [{ attempt: 1, source: "x", startedAt: iso(45) }] } };
    expect(describeMergeJobBadge(noPhase, NOW)?.label).toBe("Merging · gate · 45s · attempt 1");
    const noAttempt: MergeStatusView = { job: { ...RUNNING.job!, attempts: [] } };
    expect(describeMergeJobBadge(noAttempt, NOW)?.label).toBe("Merging · starting · 10m");
  });

  it("is null for a finished job, the absent shape and no status", () => {
    expect(describeMergeJobBadge(FAILED, NOW)).toBeNull();
    expect(describeMergeJobBadge({ job: null, outcome: "completed" }, NOW)).toBeNull();
    expect(describeMergeJobBadge(null, NOW)).toBeNull();
  });
});

describe("mergeErrorFromStatus", () => {
  it("carries the failed attempt's detail tail and the fix hint into the merge-error state", () => {
    const error = mergeErrorFromStatus("ws1", FAILED);
    expect(error?.wsId).toBe("ws1");
    expect(error?.message.endsWith("in packages/client/src/__tests__/function-nloc-baseline.ts")).toBe(true);
    expect(error?.fixHint?.kind).toBe("bank-shrinks");
  });

  it("keeps only the tail of a long detail, and uses the job error when no attempt was recorded", () => {
    const long = "x".repeat(5000);
    const status: MergeStatusView = { job: { ...FAILED.job!, attempts: [{ attempt: 1, outcome: "failed", detail: long }] }, fixHint: null };
    expect(mergeErrorFromStatus("ws1", status)?.message).toHaveLength(1201);
    const noAttempt: MergeStatusView = { job: { ...FAILED.job!, attempts: [] } };
    expect(mergeErrorFromStatus("ws1", noAttempt)?.message).toBe("pre-merge gate failed");
    expect(mergeErrorFromStatus("ws1", noAttempt)?.fixHint).toBeNull();
  });

  it("is null while running or after success", () => {
    expect(mergeErrorFromStatus("ws1", RUNNING)).toBeNull();
    expect(mergeErrorFromStatus("ws1", { job: { ...RUNNING.job!, state: "succeeded" } })).toBeNull();
  });
});

describe("isTerminalMergeStatus", () => {
  it("is terminal for a finished job and for every absent shape, not for a running one", () => {
    expect(isTerminalMergeStatus(RUNNING)).toBe(false);
    expect(isTerminalMergeStatus(FAILED)).toBe(true);
    expect(isTerminalMergeStatus({ job: null, outcome: "completed" })).toBe(true);
    expect(isTerminalMergeStatus({ job: null })).toBe(true);
    expect(isTerminalMergeStatus(null)).toBe(false);
  });
});
