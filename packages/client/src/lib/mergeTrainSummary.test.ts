import { describe, expect, it } from "vitest";
import { collectConflictClusters, describeTrainMembers, summarizeMergeTrains, type MergeTrainRowDto } from "./mergeTrainSummary.js";

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

describe("describeTrainMembers (#1197)", () => {
  it("tells a deferred (member-vs-member, #1191) drop from a base-conflict drop, a sided member and a landed one", () => {
    const row = train({
      id: "t1",
      state: "landed",
      memberWorkspaceIds: JSON.stringify(["ws-a", "ws-b", "ws-c", "ws-d", "ws-e"]),
      gateEvidence: JSON.stringify({
        landed: ["ws-a"],
        dropped: [
          { workspaceId: "ws-b", reason: "conflicts with f-a — deferred to the next train", deferred: true },
          { workspaceId: "ws-c", reason: "conflict in shared.txt" },
        ],
        sided: [{ workspaceId: "ws-d", reason: "review: missing migration" }],
      }),
      bisectResult: JSON.stringify({ gateRejected: [{ workspaceId: "ws-e", reason: "verify failed: e.txt" }] }),
    });
    expect(describeTrainMembers(row)).toEqual([
      { workspaceId: "ws-a", outcome: "landed", reason: null },
      { workspaceId: "ws-b", outcome: "deferred", reason: "conflicts with f-a — deferred to the next train" },
      { workspaceId: "ws-c", outcome: "dropped", reason: "conflict in shared.txt" },
      { workspaceId: "ws-d", outcome: "sided", reason: "review: missing migration" },
      { workspaceId: "ws-e", outcome: "gate_rejected", reason: "verify failed: e.txt" },
    ]);
  });

  it("a member of a running train the evidence has not placed is `aboard`; on a finished train it is `unresolved`", () => {
    const members = JSON.stringify(["ws-a", "ws-b"]);
    const evidence = JSON.stringify({ landed: ["ws-a"] });
    expect(describeTrainMembers(train({ state: "gating", memberWorkspaceIds: members, gateEvidence: evidence })).map((m) => m.outcome))
      .toEqual(["landed", "aboard"]);
    expect(describeTrainMembers(train({ state: "red", memberWorkspaceIds: members, gateEvidence: evidence })).map((m) => m.outcome))
      .toEqual(["landed", "unresolved"]);
  });

  it("appends ids the evidence names but the member list does not, and tolerates no evidence at all", () => {
    const row = train({
      state: "assembling",
      memberWorkspaceIds: JSON.stringify(["ws-a"]),
      gateEvidence: JSON.stringify({ dropped: [{ workspaceId: "ws-x", reason: "conflict" }] }),
    });
    expect(describeTrainMembers(row).map((m) => `${m.workspaceId}:${m.outcome}`)).toEqual(["ws-a:aboard", "ws-x:dropped"]);
    expect(describeTrainMembers(train({ state: "gating", memberWorkspaceIds: JSON.stringify(["ws-a"]) })))
      .toEqual([{ workspaceId: "ws-a", outcome: "aboard", reason: null }]);
  });
});

describe("collectConflictClusters (#1197)", () => {
  const withClusters = (id: string, label: string, startedAt: string, clusters: unknown) =>
    train({ id, label, startedAt, gateEvidence: JSON.stringify({ conflictClusters: clusters }) });

  it("lists each distinct cluster once, under the NEWEST train that recorded it, newest first", () => {
    const clusters = collectConflictClusters([
      withClusters("old", "train/2026-09-01-01", "2026-09-01T10:00:00.000Z", [{ workspaceIds: ["ws-a", "ws-b"] }]),
      withClusters("new", "train/2026-09-02-01", "2026-09-02T10:00:00.000Z", [
        { workspaceIds: ["ws-b", "ws-a"] },
        { workspaceIds: ["ws-c", "ws-d", "ws-e"] },
      ]),
    ]);
    expect(clusters).toEqual([
      { trainId: "new", trainLabel: "train/2026-09-02-01", workspaceIds: ["ws-b", "ws-a"] },
      { trainId: "new", trainLabel: "train/2026-09-02-01", workspaceIds: ["ws-c", "ws-d", "ws-e"] },
    ]);
  });

  it("reads only the newest `limit` trains — the same window the train-conflicts group scan uses", () => {
    const rows = [
      withClusters("t1", "l1", "2026-09-01T10:00:00.000Z", [{ workspaceIds: ["ws-a", "ws-b"] }]),
      withClusters("t2", "l2", "2026-09-02T10:00:00.000Z", [{ workspaceIds: ["ws-c", "ws-d"] }]),
    ];
    expect(collectConflictClusters(rows, 1).map((c) => c.trainId)).toEqual(["t2"]);
  });

  it("ignores a cluster of fewer than two ids, a malformed one, and rows without evidence", () => {
    const clusters = collectConflictClusters([
      withClusters("t1", "l1", "2026-09-01T10:00:00.000Z", [{ workspaceIds: ["ws-a"] }, { workspaceIds: "nope" }, null]),
      train({ id: "t2", gateEvidence: null }),
      train({ id: "t3", gateEvidence: "not json" }),
    ]);
    expect(clusters).toEqual([]);
  });
});
