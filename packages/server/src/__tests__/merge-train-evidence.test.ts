import { describe, expect, it } from "vitest";
import { annotateConcurrentGates, buildTrainGateEvidence } from "../services/merge-queue-train.js";
import type { TrainMember, TrainRunResult } from "../services/merge-train.service.js";
import type { MergeTrainAttemptDto } from "@agentic-kanban/shared/types";

/**
 * #1184 — the evidence `finishMergeTrain` persists is what the "Merge train" panel computes
 * its numbers from, and it was inflated: a bisect re-assembles every sub-attempt from scratch,
 * so a member conflicting with the BASE is re-dropped by each attempt that contains it (train
 * qmu4t981a: 13 members, 17 drops). `buildTrainGateEvidence` is the pure half of that
 * persistence, so the shape can be pinned without a DB.
 */
const m = (id: string): TrainMember => ({ workspaceId: id, branch: `f-${id}`, issueNumber: null });

function result(over: Partial<TrainRunResult>): TrainRunResult {
  return {
    trainRef: "kanban/train/q1",
    landed: [],
    dropped: [],
    gateRejected: [],
    sided: [],
    closeFailures: [],
    gateRuns: 0,
    attempts: [],
    ...over,
  };
}

describe("buildTrainGateEvidence (#1184)", () => {
  it("counts drops and gate-rejects by UNIQUE workspace id, keeping the first reason", () => {
    const members = [m("a"), m("b"), m("c"), m("d")];
    const { gateEvidence, gateRejected } = buildTrainGateEvidence(
      result({
        landed: [m("a"), m("b")],
        // `c` conflicts with the base: dropped by the top-level attempt and again by the
        // sub-attempt that contained it. `d` was bisected red twice over (top + singleton).
        dropped: [
          { member: m("c"), reason: "conflict in shared.txt (top level)" },
          { member: m("c"), reason: "conflict in shared.txt (sub-attempt b)" },
        ],
        gateRejected: [
          { member: m("d"), reason: "verify failed: d.txt is red" },
          { member: m("d"), reason: "verify failed: d.txt is red (again)" },
        ],
        gateRuns: 3,
        mergeSha: "abc",
      }),
      members,
    );

    expect(gateEvidence.dropped).toEqual([{ workspaceId: "c", reason: "conflict in shared.txt (top level)" }]);
    expect(gateRejected).toEqual([{ workspaceId: "d", reason: "verify failed: d.txt is red" }]);
    expect(gateEvidence).toMatchObject({
      gateRuns: 3,
      gateFailure: null,
      landed: ["a", "b"],
      mergeSha: "abc",
      memberCount: 4,
      landedCount: 2,
      uniqueDroppedCount: 1,
      gateRejectedCount: 1,
    });
    // Everyone is accounted for, so nothing is `unresolved`.
    expect(gateEvidence.unresolved).toBeUndefined();
  });

  it("still names unattributed members as `unresolved` (#1154), computed against the deduplicated lists", () => {
    const members = [m("a"), m("b"), m("c")];
    const { gateEvidence } = buildTrainGateEvidence(
      result({
        dropped: [{ member: m("c"), reason: "conflict" }, { member: m("c"), reason: "conflict" }],
        gateRuns: 1,
        gateFailure: "Cannot find module '@playwright/test'",
      }),
      members,
    );
    expect(gateEvidence.unresolved).toEqual(["a", "b"]);
    expect(gateEvidence).toMatchObject({ memberCount: 3, landedCount: 0, uniqueDroppedCount: 1, gateRejectedCount: 0 });
    expect(gateEvidence.gateFailure).toContain("Cannot find module");
  });

  it("#1194: a member sided by the train review is attributed, deduplicated, and the review evidence rides along", () => {
    const members = [m("a"), m("b"), m("c")];
    const review = { status: "ran" as const, findingCount: 2, blockingCount: 1, sidedWorkspaceIds: ["c"], blocking: true };
    const { gateEvidence } = buildTrainGateEvidence(
      result({
        landed: [m("a"), m("b")],
        // Sided by the top attempt and again by a sub-attempt that carried it.
        sided: [
          { member: m("c"), reason: "train review (#1194): CRITICAL c.txt: first" },
          { member: m("c"), reason: "train review (#1194): CRITICAL c.txt: again" },
        ],
        gateRuns: 1,
        mergeSha: "abc",
      }),
      members,
      review,
    );
    expect(gateEvidence.sided).toEqual([{ workspaceId: "c", reason: "train review (#1194): CRITICAL c.txt: first" }]);
    expect(gateEvidence).toMatchObject({ sidedCount: 1, landedCount: 2, gateRejectedCount: 0, review });
    // Sided is an attribution, not a gap.
    expect(gateEvidence.unresolved).toBeUndefined();
  });

  it("#1194: with no review the evidence carries neither `sided` nor `review`, so older readers see the old shape", () => {
    const { gateEvidence } = buildTrainGateEvidence(result({ landed: [m("a")], gateRuns: 1 }), [m("a")]);
    expect(gateEvidence.sided).toBeUndefined();
    expect(gateEvidence.sidedCount).toBeUndefined();
    expect(gateEvidence.review).toBeUndefined();
  });

  it("a fully green train: N members, N landed, one gate run, no drops", () => {
    const members = [m("a"), m("b")];
    const { gateEvidence, gateRejected } = buildTrainGateEvidence(
      result({ landed: members, gateRuns: 1, mergeSha: "def" }),
      members,
    );
    expect(gateEvidence).toMatchObject({ memberCount: 2, landedCount: 2, uniqueDroppedCount: 0, gateRejectedCount: 0, gateRuns: 1 });
    expect(gateRejected).toEqual([]);
    // #1191: no member-vs-member conflicts, so the key is absent rather than an empty list.
    expect(gateEvidence.conflictClusters).toBeUndefined();
  });

  it("#1191: carries the member-vs-member conflict clusters so the train-conflicts group scan can read them back", () => {
    const members = [m("a"), m("b"), m("c")];
    const { gateEvidence } = buildTrainGateEvidence(
      result({
        landed: [m("a"), m("c")],
        dropped: [{ member: m("b"), reason: "conflicts with f-a — deferred to the next train", deferred: true }],
        gateRuns: 1,
        mergeSha: "ghi",
        conflictClusters: [{ workspaceIds: ["a", "b"] }],
      }),
      members,
    );
    expect(gateEvidence.conflictClusters).toEqual([{ workspaceIds: ["a", "b"] }]);
    expect(gateEvidence.dropped).toEqual([{ workspaceId: "b", reason: "conflicts with f-a — deferred to the next train" }]);
  });
});

/**
 * #1193 — the bisect tree must SHOW when two halves gated at once, or the second verify slot
 * could be silently unused (13 sequential gate runs, 149 min, on train qmu4t981a) with nothing
 * in the persisted evidence to say so.
 */
describe("annotateConcurrentGates (#1193)", () => {
  const t = (minutes: number) => new Date(Date.UTC(2026, 8, 17, 12, minutes)).toISOString();
  const node = (label: string, startMin: number | null, endMin: number | null): MergeTrainAttemptDto => ({
    label,
    members: ["a"],
    included: ["a"],
    dropped: [],
    gateStartedAt: startMin === null ? null : t(startMin),
    gateFinishedAt: endMin === null ? null : t(endMin),
    gateRuns: startMin === null ? 0 : 1,
    verdict: "red",
  });

  it("marks two overlapping halves as concurrent with each other and totals the saving", () => {
    // Root gated 0-10, then both halves 10-20 and 10-18 at once: sequentially that is 28 min
    // of gating, concurrently it occupied 20 — 8 min saved.
    const { attempts, concurrentGateSavedMs } = annotateConcurrentGates([
      node("q1", 0, 10),
      node("q1a", 10, 20),
      node("q1b", 10, 18),
    ]);
    expect(attempts[0].concurrentWith).toBeUndefined();
    expect(attempts[1].concurrentWith).toEqual(["q1b"]);
    expect(attempts[2].concurrentWith).toEqual(["q1a"]);
    expect(concurrentGateSavedMs).toBe(8 * 60_000);
  });

  it("a sequential tree carries no annotation and a saving of 0 — a gate starting the instant another ends is sequential", () => {
    const { attempts, concurrentGateSavedMs } = annotateConcurrentGates([
      node("q1", 0, 10),
      node("q1a", 10, 20),
      node("q1b", 20, 30),
    ]);
    expect(attempts.every((a) => a.concurrentWith === undefined)).toBe(true);
    expect(concurrentGateSavedMs).toBe(0);
  });

  it("ignores nodes that never gated (assembly_empty), and reaches the persisted evidence", () => {
    const empty = { ...node("q1b", null, null), verdict: "assembly_empty" as const };
    const members = [m("a")];
    const { gateEvidence } = buildTrainGateEvidence(
      result({ gateRuns: 2, attempts: [node("q1", 0, 10), node("q1a", 10, 15), empty] }),
      members,
    );
    expect(gateEvidence.concurrentGateSavedMs).toBe(0);
    expect(gateEvidence.attempts?.map((a) => a.concurrentWith)).toEqual([undefined, undefined, undefined]);
  });
});
