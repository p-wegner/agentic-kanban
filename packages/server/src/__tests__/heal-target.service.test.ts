import { describe, expect, it } from "vitest";
import { applyFlushTransition, type FlushRecord } from "../services/flush-state.js";
import { healOpenBlocksMerging, healTargetPrefKey, healTicketKey, resolveHealTarget } from "../services/heal-target.service.js";

/**
 * #1249, decision 020 part 4 — heal target: `rc` when a project has a promotion cadence, else
 * `master`; overridable; both shapes keep merging while a heal is open.
 */

describe("resolveHealTarget (#1249)", () => {
  const projectId = "p1";

  it("defaults to master when no promote_cadence is set", () => {
    expect(resolveHealTarget(new Map(), projectId)).toBe("master");
  });

  it("defaults to master when promote_cadence is explicitly off", () => {
    const prefMap = new Map([[`promote_cadence_${projectId}`, "off"]]);
    expect(resolveHealTarget(prefMap, projectId)).toBe("master");
  });

  it("derives rc when promote_cadence names a daily cadence", () => {
    const prefMap = new Map([[`promote_cadence_${projectId}`, "daily@03:00"]]);
    expect(resolveHealTarget(prefMap, projectId)).toBe("rc");
  });

  it("an explicit heal_target override wins over the derived default", () => {
    const prefMap = new Map([
      [`promote_cadence_${projectId}`, "daily@03:00"],
      [healTargetPrefKey(projectId), "master"],
    ]);
    expect(resolveHealTarget(prefMap, projectId)).toBe("master");

    const prefMap2 = new Map([[healTargetPrefKey(projectId), "rc"]]);
    expect(resolveHealTarget(prefMap2, projectId)).toBe("rc");
  });

  it("an unparseable override is ignored — falls through to the derived default rather than failing to master", () => {
    const prefMap = new Map([
      [`promote_cadence_${projectId}`, "daily@03:00"],
      [healTargetPrefKey(projectId), "bogus"],
    ]);
    expect(resolveHealTarget(prefMap, projectId)).toBe("rc");
  });
});

describe("healTicketKey (#1249)", () => {
  it("keys on the flush tag, never the rc", () => {
    expect(healTicketKey("flush/2026-09-26-1", "typecheck-fail")).toBe("flush/2026-09-26-1::typecheck-fail");
  });
});

describe("healOpenBlocksMerging (#1249)", () => {
  it("never blocks, under either target", () => {
    expect(healOpenBlocksMerging("rc", "healing")).toBe(false);
    expect(healOpenBlocksMerging("master", "sweeping")).toBe(false);
  });
});

// ── the master shape's state machine: healed collapses to merged-back in one step ──────────

describe("the master shape's merge-back is a no-op collapse (#1249, via flush-state.ts)", () => {
  const base: FlushRecord = {
    id: "flush/2026-09-26-1",
    at: "2026-09-26T00:00:00.000Z",
    triggeredBy: "manual",
    memberIssueNumbers: [1, 2],
    memberBranches: ["a", "b"],
    landingSha: "deadbeef",
    tag: "flush/2026-09-26-1",
    sweepTarget: "master",
    state: "sweeping",
    openHealTickets: [],
    updatedAt: "2026-09-26T00:00:00.000Z",
  };

  it("master shape: healed -> merged-back happens in the SAME transition call", () => {
    const healing = applyFlushTransition({ ...base, state: "red" }, "healing");
    expect(healing.result.ok).toBe(true);
    expect(healing.record.state).toBe("healing");

    const healed = applyFlushTransition(healing.record, "healed");
    expect(healed.result.ok).toBe(true);
    // Collapsed straight through — no separate merged-back call needed for the master shape.
    expect(healed.record.state).toBe("merged-back");
  });

  it("rc shape: healed stays healed, a SEPARATE merged-back call is required", () => {
    const rcRecord: FlushRecord = { ...base, sweepTarget: "rc" };
    const healing = applyFlushTransition({ ...rcRecord, state: "red" }, "healing");
    const healed = applyFlushTransition(healing.record, "healed");
    expect(healed.record.state).toBe("healed");

    const mergedBack = applyFlushTransition(healed.record, "merged-back");
    expect(mergedBack.result.ok).toBe(true);
    expect(mergedBack.record.state).toBe("merged-back");
  });
});
