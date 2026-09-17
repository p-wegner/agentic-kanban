import { describe, expect, it } from "vitest";
import { buildTrainGateEvidence } from "../services/merge-queue-train.js";
import type { TrainMember, TrainRunResult } from "../services/merge-train.service.js";

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

  it("a fully green train: N members, N landed, one gate run, no drops", () => {
    const members = [m("a"), m("b")];
    const { gateEvidence, gateRejected } = buildTrainGateEvidence(
      result({ landed: members, gateRuns: 1, mergeSha: "def" }),
      members,
    );
    expect(gateEvidence).toMatchObject({ memberCount: 2, landedCount: 2, uniqueDroppedCount: 0, gateRejectedCount: 0, gateRuns: 1 });
    expect(gateRejected).toEqual([]);
  });
});
