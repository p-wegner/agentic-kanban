/**
 * #1240 — the `flow` risk posture (decision 019 part 3): the highest-risk-tolerant integration
 * style as a LEVEL on the dial, below `iterate` on the ladder (`docs/integration-risk-ladder.md`).
 *
 * What it pins, each visible where it acts:
 *  - the posture table row, as a snapshot — every field, so a drift in any of them is a reviewed
 *    change to this file and to decision 017's amendment;
 *  - `report` is what `flow` resolves, and the red-base veto returns no hold for it;
 *  - `guards-at-merge` yields `intersecting` for `flow` (pref may still pin `all`);
 *  - the gate's pass message prices the deferred floor under `flow` exactly as under `iterate`,
 *    and carries the posture summary that names every skip;
 *  - `describeBaseSweep` says "full suite: release candidate only" rather than the opt-in
 *    rule's "no posture chosen" — `nominalIntervalMs: null` and `postureSource: risk_posture`
 *    are the two facts that keep those apart on the wire.
 *
 * The end-to-end train-window case (a red row plus a ready train through the real resolver)
 * lives in `merge-train-base-veto-posture.test.ts` beside the `iterate`/`standard` cases.
 */
import { describe, expect, it } from "vitest";
import { RISK_POSTURES, RISK_POSTURE_DESCRIPTIONS, RISK_POSTURE_LABELS } from "@agentic-kanban/shared/lib/risk-posture";
import {
  describeBaseSweep,
  resolveBaseSweepIntervalMs,
  resolveRiskPosture,
  riskPosturePrefKey,
  redBasePolicyPrefKey,
} from "../services/risk-posture.service.js";
import { guardsAtMergePrefKey, resolveGuardsAtMerge } from "../services/guards-at-merge.js";
import { decideBaseRedVeto } from "../services/merge-train-base-veto.js";
import { buildGateTierMessage, resolveGateTier, type GateTierInfo } from "../services/pre-merge-gate-tier.js";

const PID = "p-1240";
const prefs = (entries: Record<string, string> = {}): Map<string, string> => new Map(Object.entries(entries));
const flowPrefs = (extra: Record<string, string> = {}) => prefs({ [riskPosturePrefKey(PID)]: "flow", ...extra });

describe("the `flow` risk posture (#1240)", () => {
  it("is a registered level with a label and a description that names every skip", () => {
    expect(RISK_POSTURES).toContain("flow");
    expect(RISK_POSTURE_LABELS.flow).toBe("Flow");
    for (const phrase of ["NO always-run guard floor", "release candidate ONLY", "reported, never blocking"]) {
      expect(RISK_POSTURE_DESCRIPTIONS.flow).toContain(phrase);
    }
  });

  it("resolves the pinned row — `iterate` with no master sweep, no guard floor and a `report` red base", () => {
    const p = resolveRiskPosture(flowPrefs(), PID);
    expect(p).toEqual({
      level: "flow",
      source: "risk_posture",
      gateTier: "impact",
      sweepIntervalMs: null,
      reviewMode: "standard",
      redBasePolicy: "report",
      trainMaxSize: 1,
      trainMaxWaitMs: 0,
      mergesPerCycle: 2,
      relaunchesPerCycle: 2,
      builderStopChecks: "tests-capacity-gated",
      contentionMode: "serialize",
      placementBias: "host-preferred",
      summary: "flow: merge gate = typecheck + impact selection + the diff's own tests; no guard floor at merge; red base reported, never blocking; the full suite runs on the release candidate only",
    });
    // Everything `iterate` has that is not one of the three named differences is the same.
    const iterate = resolveRiskPosture(prefs({ [riskPosturePrefKey(PID)]: "iterate" }), PID);
    for (const key of ["gateTier", "reviewMode", "trainMaxSize", "trainMaxWaitMs", "mergesPerCycle", "relaunchesPerCycle", "builderStopChecks", "contentionMode", "placementBias"] as const) {
      expect(p[key], key).toEqual(iterate[key]);
    }
  });

  it("the summary names every skip the ticket lists", () => {
    const { summary } = resolveRiskPosture(flowPrefs(), PID);
    expect(summary.startsWith("flow:")).toBe(true);
    for (const phrase of ["typecheck", "impact selection", "the diff's own tests", "no guard floor at merge", "red base reported, never blocking", "release candidate only"]) {
      expect(summary).toContain(phrase);
    }
  });

  it("a red base under `flow` never holds the train window, and the override cannot tighten it", () => {
    const p = resolveRiskPosture(flowPrefs(), PID);
    expect(decideBaseRedVeto({ outcome: "red", healthSha: "a".repeat(40), baseAheadOfHealthSha: false, redBasePolicy: p.redBasePolicy }, "4 guards red")).toBeNull();
    // `report` is the softest rank: a project override asking for `block` is ignored (softer only).
    const tightened = resolveRiskPosture(flowPrefs({ [redBasePolicyPrefKey(PID)]: "block" }), PID);
    expect(tightened.redBasePolicy).toBe("report");
  });

  it("the merge gate forces only intersecting guards under `flow`, unless the pref pins `all`", () => {
    expect(resolveGuardsAtMerge(flowPrefs(), PID)).toMatchObject({ guardsAtMerge: "intersecting", source: "posture" });
    expect(resolveGuardsAtMerge(flowPrefs({ [guardsAtMergePrefKey(PID)]: "all" }), PID)).toMatchObject({ guardsAtMerge: "all", source: "pref" });
    // And the tier the gate runs is the impact selection, from the posture, not from a pref.
    expect(resolveGateTier(flowPrefs(), PID)).toMatchObject({ strategy: "impact", fromPosture: true });
  });

  it("the pass message prices the deferred floor and carries the posture summary", () => {
    const { posture } = resolveGateTier(flowPrefs(), PID);
    const tierInfo: GateTierInfo = {
      strategy: "impact",
      selector: "impact",
      impactSelection: { selectedCount: 2, belowFloorCount: 40, stale: false, estMs: 3_000 },
      packageScoped: true,
      fileScoped: false,
      changedFileCount: 3,
      guardSuiteCount: 12,
      guardDeferredCount: 180,
      guardTotalCount: 192,
      guardsAtMerge: "intersecting",
      maxWorkers: 4,
      posture,
    };
    const message = buildGateTierMessage(tierInfo);
    expect(message).toContain("tier: impact-selected");
    expect(message).toContain("guards: 12 intersecting of 192 (180 deferred to the base sweep)");
    expect(message).toContain("[risk posture: flow: merge gate = typecheck + impact selection");
    expect(message).toContain("the full suite runs on the release candidate only (source: risk_posture)]");
  });

  it("schedules no master sweep by design, and the wire struct says so rather than 'no posture chosen'", () => {
    const p = resolveRiskPosture(flowPrefs(), PID);
    expect(resolveBaseSweepIntervalMs(p)).toBeNull();
    const info = describeBaseSweep(p, "2026-09-24T00:00:00.000Z");
    expect(info).toMatchObject({
      scheduled: false,
      intervalMs: null,
      nominalIntervalMs: null,
      postureLevel: "flow",
      postureSource: "risk_posture",
      nextDueAt: null,
    });
    expect(info.reason).toContain("full suite: release candidate only");
    expect(info.reason).not.toContain("no risk posture chosen");
    // The opt-in rule's wording is unchanged for the case it describes.
    expect(describeBaseSweep(resolveRiskPosture(prefs(), PID)).reason).toContain("no risk posture chosen");
  });
});
