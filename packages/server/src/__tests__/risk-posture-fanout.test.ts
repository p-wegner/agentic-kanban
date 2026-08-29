/**
 * #937 — the remaining `RiskPosture` fan-out (#911 follow-up, decision 017).
 *
 * `resolveRiskPosture` landed with ONE consumer wired (`contentionMode`). This suite pins the
 * four this ticket wires — `gateTier`, `reviewMode`, `trainMaxSize`/`trainMaxWaitMs` and
 * `placementBias` — against the two properties that make the fan-out safe rather than merely
 * present:
 *
 *  1. **`standard` reproduces today's behaviour EXACTLY.** Every resolver below is asserted
 *     against the value it produced before this ticket, on an empty prefMap. A fan-out that
 *     silently retuned a default would be indistinguishable from a bug in production.
 *  2. **The explicit pref still wins.** Each field keeps its finer-grained per-project
 *     override, the same escape hatch #911 kept for `file_contention_<projectId>`.
 *
 * Plus decision 017's VISIBILITY rule: a message that read a posture field names what that
 * posture skips.
 */
import { describe, it, expect } from "vitest";
import {
  formatPostureNote,
  remoteDispatchBlockedByPlacementBias,
  resolveRiskPosture,
  riskPosturePrefKey,
} from "../services/risk-posture.service.js";
import {
  buildGateTierMessage,
  DEFAULT_VERIFY_GATE_STRATEGY,
  resolveGateTier,
  verifyGateStrategyPrefKey,
} from "../services/pre-merge-gate-tier.js";
import { resolveProjectReviewMode, reviewModePref } from "../services/review-mode-pref.js";
import {
  DEFAULT_TRAIN_MAX_SIZE,
  DEFAULT_TRAIN_MAX_WAIT_MS,
  resolveTrainOptInSize,
  resolveTrainWindowConfig,
} from "../services/merge-train-window.js";
import { PLACEMENT_CHECK_CHAIN } from "../services/placement-explain.service.js";

const PID = "11111111-2222-3333-4444-555555555555";

function prefs(entries: Record<string, string> = {}): Map<string, string> {
  return new Map(Object.entries(entries));
}

function posture(level: string): Map<string, string> {
  return prefs({ [riskPosturePrefKey(PID)]: level });
}

describe("gateTier → resolveGateTier (#937)", () => {
  it("standard reproduces DEFAULT_VERIFY_GATE_STRATEGY exactly", () => {
    const r = resolveGateTier(prefs(), PID);
    expect(r.strategy).toBe(DEFAULT_VERIFY_GATE_STRATEGY);
    expect(r.strategy).toBe("full");
    expect(r.fromPosture).toBe(true);
    expect(r.posture.level).toBe("standard");
  });

  it("a weaker posture selects its own tier", () => {
    expect(resolveGateTier(posture("fast"), PID).strategy).toBe("scoped");
    expect(resolveGateTier(posture("sprint"), PID).strategy).toBe("scoped-base-watch");
    expect(resolveGateTier(posture("strict"), PID).strategy).toBe("full");
  });

  it("an explicit verify_gate_strategy_<id> still wins over the posture", () => {
    const map = posture("sprint");
    map.set(verifyGateStrategyPrefKey(PID), "full");
    const r = resolveGateTier(map, PID);
    expect(r.strategy).toBe("full");
    expect(r.fromPosture).toBe(false);
  });

  it("an unrecognised explicit value falls back to the posture, not to the shipped default", () => {
    const map = posture("fast");
    map.set(verifyGateStrategyPrefKey(PID), "nonsense");
    const r = resolveGateTier(map, PID);
    expect(r.strategy).toBe("scoped");
    expect(r.fromPosture).toBe(true);
  });

  it("the gate message folds the posture summary in when the posture chose the tier", () => {
    const p = resolveRiskPosture(posture("fast"), PID);
    const message = buildGateTierMessage({
      strategy: "scoped",
      packageScoped: true,
      fileScoped: false,
      changedFileCount: 3,
      guardSuiteCount: 66,
      maxWorkers: 4,
      posture: p,
    });
    expect(message).toContain("tier: package-scoped");
    expect(message).toContain("risk posture:");
    expect(message).toContain(p.summary);
    expect(message).toContain("source: risk_posture");
  });

  it("says nothing about a posture when none decided — 'no note' must not read as 'standard'", () => {
    const message = buildGateTierMessage({
      strategy: "full",
      packageScoped: false,
      fileScoped: false,
      changedFileCount: 3,
      guardSuiteCount: 66,
      maxWorkers: 4,
    });
    expect(message).not.toContain("risk posture");
  });
});

describe("reviewMode → resolveProjectReviewMode (#937)", () => {
  it("standard reproduces today's behaviour: review runs, per-ticket, not thorough", () => {
    const r = resolveProjectReviewMode(prefs(), PID);
    expect(r).toMatchObject({ run: true, mode: "per-ticket", thorough: false });
  });

  it("strict escalates to the thorough review skill, still per-ticket", () => {
    expect(resolveProjectReviewMode(posture("strict"), PID)).toMatchObject({
      run: true, mode: "per-ticket", thorough: true,
    });
  });

  it("fast reviews the train instead of each ticket", () => {
    expect(resolveProjectReviewMode(posture("fast"), PID)).toMatchObject({
      run: true, mode: "per-train", thorough: false,
    });
  });

  it("sprint skips per-ticket review entirely", () => {
    expect(resolveProjectReviewMode(posture("sprint"), PID).run).toBe(false);
  });

  it("an explicit review_mode_<id> wins for the MODE, and says nothing about run/thorough", () => {
    const map = posture("sprint");
    map.set(reviewModePref.key(PID), "per-ticket");
    const r = resolveProjectReviewMode(map, PID);
    expect(r.mode).toBe("per-ticket");
    // The override is about assembly, not about whether review happens at all.
    expect(r.run).toBe(false);
  });

  it("a per-ticket risk:<level> issue tag overrides the project pref", () => {
    // The tag override reaches this resolver through the same prefMap+posture path; assert the
    // underlying resolver honours it so the mapping above is not the only thing tested.
    const p = resolveRiskPosture(posture("standard"), PID, { tagOverride: "risk:sprint" });
    expect(p.reviewMode).toBe("none");
    expect(p.source).toBe("issue_tag");
  });
});

describe("trainMaxSize / trainMaxWaitMs (#937)", () => {
  it("the QUEUE opt-in defaults to 1 under standard and strict — the sequential path, unchanged", () => {
    expect(resolveTrainOptInSize(prefs(), PID)).toBe(1);
    expect(resolveTrainOptInSize(posture("strict"), PID)).toBe(1);
  });

  it("fast and sprint opt into batching via the posture alone", () => {
    expect(resolveTrainOptInSize(posture("fast"), PID)).toBe(8);
    expect(resolveTrainOptInSize(posture("sprint"), PID)).toBe(12);
  });

  it("an explicit train_max_size_<id> still wins over the posture", () => {
    const map = posture("sprint");
    map.set(`train_max_size_${PID}`, "3");
    expect(resolveTrainOptInSize(map, PID)).toBe(3);
  });

  it("the WINDOW keeps its shipped defaults under standard — a posture may not retune an untouched knob", () => {
    const c = resolveTrainWindowConfig(prefs(), PID);
    expect(c.maxSize).toBe(DEFAULT_TRAIN_MAX_SIZE);
    expect(c.maxWaitMs).toBe(DEFAULT_TRAIN_MAX_WAIT_MS);
    expect(c.batchingFromPosture).toBe(false);
    // strict's row is the same numbers for the opposite reason, and must behave the same here.
    expect(resolveTrainWindowConfig(posture("strict"), PID).maxSize).toBe(DEFAULT_TRAIN_MAX_SIZE);
  });

  it("a posture that ASKS for batching drives the window", () => {
    const c = resolveTrainWindowConfig(posture("fast"), PID);
    expect(c.maxSize).toBe(8);
    expect(c.maxWaitMs).toBe(20 * 60 * 1000);
    expect(c.batchingFromPosture).toBe(true);
  });

  it("the two explicit prefs override INDEPENDENTLY of each other", () => {
    const sizeOnly = posture("fast");
    sizeOnly.set(`train_max_size_${PID}`, "2");
    expect(resolveTrainWindowConfig(sizeOnly, PID)).toMatchObject({ maxSize: 2, maxWaitMs: 20 * 60 * 1000 });

    const waitOnly = posture("fast");
    waitOnly.set(`train_max_wait_ms_${PID}`, "5000");
    expect(resolveTrainWindowConfig(waitOnly, PID)).toMatchObject({ maxSize: 8, maxWaitMs: 5000 });
  });

  it("an explicit wait of 0 is honoured, not treated as unset", () => {
    const map = posture("fast");
    map.set(`train_max_wait_ms_${PID}`, "0");
    expect(resolveTrainWindowConfig(map, PID).maxWaitMs).toBe(0);
  });
});

describe("placementBias → remoteDispatchBlockedByPlacementBias (#937)", () => {
  it("standard's host-preferred does NOT block — today's behaviour, no new host fallback", () => {
    expect(remoteDispatchBlockedByPlacementBias(resolveRiskPosture(prefs(), PID)).blocked).toBe(false);
  });

  it("strict's host-half blocks remote dispatch and says why", () => {
    const verdict = remoteDispatchBlockedByPlacementBias(resolveRiskPosture(posture("strict"), PID));
    expect(verdict.blocked).toBe(true);
    if (verdict.blocked) expect(verdict.reason).toContain("host-half");
  });

  it("fast/sprint's remote-preferred is a preference, not a restriction — it never blocks", () => {
    expect(remoteDispatchBlockedByPlacementBias(resolveRiskPosture(posture("fast"), PID)).blocked).toBe(false);
    expect(remoteDispatchBlockedByPlacementBias(resolveRiskPosture(posture("sprint"), PID)).blocked).toBe(false);
  });

  it("the placement chain declares the check, pointing at the posture pref an operator would change", () => {
    const check = PLACEMENT_CHECK_CHAIN.find((c) => c.id === "placement_bias");
    expect(check, "placement_bias is missing from PLACEMENT_CHECK_CHAIN").toBeTruthy();
    expect(check!.prefKeys(PID)).toContain(riskPosturePrefKey(PID));
  });
});

describe("formatPostureNote — decision 017's visibility rule (#937)", () => {
  it("names the summary and the source", () => {
    const note = formatPostureNote(resolveRiskPosture(posture("sprint"), PID));
    expect(note).toContain("no per-ticket review");
    expect(note).toContain("source: risk_posture");
  });

  it("is empty for a missing posture, so a caller cannot claim one it never resolved", () => {
    expect(formatPostureNote(undefined)).toBe("");
    expect(formatPostureNote(null)).toBe("");
  });
});
