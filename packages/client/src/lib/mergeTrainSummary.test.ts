import { describe, expect, it } from "vitest";
import { summarizeMergeTrains, type MergeTrainRowDto } from "./mergeTrainSummary.js";

function train(overrides: Partial<MergeTrainRowDto>): MergeTrainRowDto {
  return {
    id: "train-1",
    projectId: "project-1",
    label: "q123",
    memberWorkspaceIds: "[]",
    state: "landed",
    gateEvidence: null,
    bisectResult: null,
    reconciledReason: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("summarizeMergeTrains", () => {
  it("reports no train aboard and no history for an empty list", () => {
    const summary = summarizeMergeTrains([]);
    expect(summary.aboard).toEqual([]);
    expect(summary.aboardMemberCount).toBe(0);
    expect(summary.waitingCount).toBe(0);
    expect(summary.lastGate).toBeNull();
    expect(summary.redDebtDelta).toBe(0);
  });

  it("counts a gating train as aboard with its member count", () => {
    const summary = summarizeMergeTrains([
      train({ id: "t1", state: "gating", memberWorkspaceIds: JSON.stringify(["ws-1", "ws-2"]) }),
    ]);
    expect(summary.aboard.map((t) => t.id)).toEqual(["t1"]);
    expect(summary.aboardMemberCount).toBe(2);
    expect(summary.waitingCount).toBe(0);
  });

  it("counts terminal rows as waiting/history, not aboard", () => {
    const summary = summarizeMergeTrains([
      train({ id: "t1", state: "landed" }),
      train({ id: "t2", state: "abandoned" }),
    ]);
    expect(summary.aboard).toEqual([]);
    expect(summary.waitingCount).toBe(2);
  });

  it("reads the most recent train's gate evidence as lastGate", () => {
    const older = train({
      id: "old",
      state: "landed",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      gateEvidence: JSON.stringify({ gateRuns: 1 }),
    });
    const newer = train({
      id: "new",
      state: "red",
      startedAt: new Date().toISOString(),
      gateEvidence: JSON.stringify({ gateRuns: 3 }),
    });
    const summary = summarizeMergeTrains([older, newer]);
    expect(summary.lastGate).toEqual({ trainId: "new", state: "red", gateRuns: 3, finishedAt: newer.finishedAt });
  });

  it("computes a positive red-debt delta when trains drop more members than they land", () => {
    const summary = summarizeMergeTrains([
      train({
        id: "t1",
        state: "red",
        gateEvidence: JSON.stringify({ landed: [], dropped: [{ workspaceId: "ws-1", reason: "gate failed" }] }),
      }),
    ]);
    expect(summary.redDebtDelta).toBe(1);
  });

  it("computes a non-positive red-debt delta when trains land more than they drop", () => {
    const summary = summarizeMergeTrains([
      train({
        id: "t1",
        state: "landed",
        gateEvidence: JSON.stringify({ landed: ["ws-1", "ws-2"], dropped: [{ workspaceId: "ws-3", reason: "stale" }] }),
      }),
    ]);
    expect(summary.redDebtDelta).toBe(-1);
  });

  it("tolerates malformed JSON in memberWorkspaceIds and gateEvidence", () => {
    const summary = summarizeMergeTrains([
      train({ id: "t1", state: "gating", memberWorkspaceIds: "not json", gateEvidence: "not json" }),
    ]);
    expect(summary.aboardMemberCount).toBe(0);
    expect(summary.lastGate?.gateRuns).toBeNull();
  });
});
