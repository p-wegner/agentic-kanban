import { describe, it, expect } from "vitest";
import {
  RED_BASE_POLICY_RANK,
  describeBaseSweep,
  formatIntervalHuman,
  redBasePolicyPrefKey,
  resolveBaseSweepIntervalMs,
  resolveRiskPosture,
  riskPosturePrefKey,
  type RedBasePolicy,
} from "./risk-posture.service.js";

const PID = "11111111-2222-3333-4444-555555555555";

function prefs(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

// @covers preferences-config.resolve.risk-posture [config,risk]
describe("resolveRiskPosture", () => {
  it("defaults to standard when nothing is set, and standard matches today's behaviour", () => {
    const p = resolveRiskPosture(prefs({}), PID);
    expect(p.level).toBe("standard");
    expect(p.source).toBe("default");
    expect(p.gateTier).toBe("full");
    expect(p.reviewMode).toBe("standard");
    expect(p.redBasePolicy).toBe("block");
    expect(p.trainMaxSize).toBe(1);
    expect(p.trainMaxWaitMs).toBe(0);
    expect(p.contentionMode).toBe("serialize");
    expect(p.summary).toContain("standard");
  });

  it("explicit risk_posture_<id> pref wins", () => {
    const p = resolveRiskPosture(prefs({ [riskPosturePrefKey(PID)]: "strict" }), PID);
    expect(p.level).toBe("strict");
    expect(p.source).toBe("risk_posture");
    expect(p.gateTier).toBe("full");
    expect(p.reviewMode).toBe("thorough");
    expect(p.trainMaxSize).toBe(1);
    expect(p.contentionMode).toBe("serialize");
  });

  it("fast: scoped gate, train review, red-base-allowed-if-known-debt, warn contention", () => {
    const p = resolveRiskPosture(prefs({ [riskPosturePrefKey(PID)]: "fast" }), PID);
    expect(p.level).toBe("fast");
    expect(p.gateTier).toBe("scoped");
    expect(p.reviewMode).toBe("train-only");
    expect(p.redBasePolicy).toBe("allow-known-debt");
    expect(p.trainMaxSize).toBe(8);
    expect(p.trainMaxWaitMs).toBe(20 * 60 * 1000);
    expect(p.builderStopChecks).toBe("typecheck-only");
    expect(p.contentionMode).toBe("warn");
    expect(p.placementBias).toBe("remote-preferred");
  });

  it("sprint: guards-only gate, no review, contention off, no builder self-tests", () => {
    const p = resolveRiskPosture(prefs({ [riskPosturePrefKey(PID)]: "sprint" }), PID);
    expect(p.level).toBe("sprint");
    expect(p.gateTier).toBe("scoped-base-watch");
    expect(p.reviewMode).toBe("none");
    expect(p.redBasePolicy).toBe("allow-file-debt-ticket");
    expect(p.trainMaxSize).toBe(12);
    expect(p.builderStopChecks).toBe("none");
    expect(p.contentionMode).toBe("off");
  });

  it("an unrecognized pref value falls back to standard", () => {
    const p = resolveRiskPosture(prefs({ [riskPosturePrefKey(PID)]: "bogus" }), PID);
    expect(p.level).toBe("standard");
    expect(p.source).toBe("default");
  });

  it("a per-ticket risk:<level> tag override wins over the project pref", () => {
    const p = resolveRiskPosture(
      prefs({ [riskPosturePrefKey(PID)]: "standard" }),
      PID,
      { tagOverride: "risk:strict" },
    );
    expect(p.level).toBe("strict");
    expect(p.source).toBe("issue_tag");
  });

  it("an unrecognized risk:<level> tag is ignored and falls back to the project pref", () => {
    const p = resolveRiskPosture(
      prefs({ [riskPosturePrefKey(PID)]: "fast" }),
      PID,
      { tagOverride: "risk:bogus" },
    );
    expect(p.level).toBe("fast");
    expect(p.source).toBe("risk_posture");
  });

  it("#919: per-cycle merge/relaunch caps are posture-derived, and standard keeps today's 2/2", () => {
    const caps = (level: string) => {
      const p = resolveRiskPosture(prefs({ [riskPosturePrefKey(PID)]: level }), PID);
      return { merges: p.mergesPerCycle, relaunches: p.relaunchesPerCycle };
    };
    // `standard` must reproduce the retired board-wide constants exactly, or this ticket
    // changes behaviour for every project that never opted into a posture.
    expect(caps("standard")).toEqual({ merges: 2, relaunches: 2 });
    expect(resolveRiskPosture(prefs({}), PID).mergesPerCycle).toBe(2);

    expect(caps("strict").merges).toBe(1);
    // The acceptance criterion: a `sprint` project must be able to land 6 ready workspaces
    // in ONE cycle, so its cap has to be at least 6.
    expect(caps("sprint").merges).toBeGreaterThanOrEqual(6);

    // Monotonic in the direction of the dial — a looser posture never lands fewer.
    const order = ["strict", "standard", "fast", "sprint"].map(caps);
    for (let i = 1; i < order.length; i++) {
      expect(order[i].merges).toBeGreaterThanOrEqual(order[i - 1].merges);
      expect(order[i].relaunches).toBeGreaterThanOrEqual(order[i - 1].relaunches);
    }
  });

  it("every posture's summary names what it does relative to standard", () => {
    for (const level of ["strict", "iterate", "fast", "sprint", "flow"] as const) {
      const p = resolveRiskPosture(prefs({ [riskPosturePrefKey(PID)]: level }), PID);
      expect(p.summary.startsWith(`${level}:`)).toBe(true);
    }
  });
});

// @covers preferences-config.resolve.risk-posture [config,risk]
describe("iterate posture (#983)", () => {
  it("is one of the two postures that yield the impact gate tier (the other is `flow`, #1240)", () => {
    const iterate = resolveRiskPosture(prefs({ [riskPosturePrefKey(PID)]: "iterate" }), PID);
    expect(iterate.gateTier).toBe("impact");
    expect(resolveRiskPosture(prefs({ [riskPosturePrefKey(PID)]: "flow" }), PID).gateTier).toBe("impact");

    for (const level of ["strict", "standard", "fast", "sprint"] as const) {
      expect(resolveRiskPosture(prefs({ [riskPosturePrefKey(PID)]: level }), PID).gateTier).not.toBe("impact");
    }
  });

  it("pairs the narrow gate with a daily FULL sweep — the backstop is the whole argument", () => {
    const p = resolveRiskPosture(prefs({ [riskPosturePrefKey(PID)]: "iterate" }), PID);
    expect(p.sweepIntervalMs).toBe(24 * 60 * 60 * 1000);
    // Without a scheduled full run, `impact` would weaken verification with nothing behind it.
    expect(resolveBaseSweepIntervalMs(p)).not.toBeNull();
  });
});

// @covers preferences-config.resolve.risk-posture [config,risk]
describe("resolveBaseSweepIntervalMs — the sweep is OPT-IN (#983)", () => {
  it("returns null for a project that never chose a posture", () => {
    const p = resolveRiskPosture(prefs({}), PID);
    expect(p.source).toBe("default");
    // The nominal cadence of the LEVEL is still there; the resolver is what makes it "never".
    expect(p.sweepIntervalMs).toBe(12 * 60 * 60 * 1000);
    expect(resolveBaseSweepIntervalMs(p)).toBeNull();
  });

  // #1031: the PINNED per-posture table. Decision 017 (Amendment 2026-09-04 #1031) names each
  // of these; a change here is a cadence decision and must amend that record too.
  const PINNED_SWEEP_INTERVALS = {
    strict: 12 * 60 * 60 * 1000,
    standard: 12 * 60 * 60 * 1000,
    iterate: 24 * 60 * 60 * 1000,
    fast: 6 * 60 * 60 * 1000,
    sprint: 24 * 60 * 60 * 1000,
    // #1240: `null` is a pinned VALUE here, not an absence — `flow` owes its full verdict on the
    // release candidate only (decision 019), so master has no scheduled sweep by design.
    flow: null,
  } as const;

  it("returns the level's cadence once a posture is explicitly set — pinned per posture (#1031)", () => {
    for (const [level, expected] of Object.entries(PINNED_SWEEP_INTERVALS)) {
      const p = resolveRiskPosture(prefs({ [riskPosturePrefKey(PID)]: level }), PID);
      expect(p.source).toBe("risk_posture");
      expect(resolveBaseSweepIntervalMs(p), level).toBe(expected);
    }
  });

  it("#1031: NO posture runs a full-suite sweep more often than every 6 h — the 30-min constant is gone", () => {
    // `standard` was the last posture on the pre-posture 30-minute constant: 48 full-suite runs a
    // day on the shared box, while every other posture swept 2-4x. `BASE_HEALTH_DEFAULT_INTERVAL_MS`
    // is now ONLY the sweep loop's tick rate, and no posture may quietly re-adopt it.
    for (const [level, pinned] of Object.entries(PINNED_SWEEP_INTERVALS)) {
      if (pinned === null) continue; // `flow` sweeps master never, which is not "more often".
      const p = resolveRiskPosture(prefs({ [riskPosturePrefKey(PID)]: level }), PID);
      expect(resolveBaseSweepIntervalMs(p)!, level).toBeGreaterThanOrEqual(6 * 60 * 60 * 1000);
    }
    // And `standard` shares `strict`'s half-daily cadence, for the same reason: a `full`
    // per-merge gate already verifies every landing.
    const standard = resolveRiskPosture(prefs({ [riskPosturePrefKey(PID)]: "standard" }), PID);
    const strict = resolveRiskPosture(prefs({ [riskPosturePrefKey(PID)]: "strict" }), PID);
    expect(standard.gateTier).toBe("full");
    expect(standard.sweepIntervalMs).toBe(strict.sweepIntervalMs);
  });

  it("a per-ticket risk: TAG does not opt the project in", () => {
    // A tag is scoped to one ticket's workspace; it cannot speak for a project-wide periodic
    // sweep, and reading it as consent would start background compute nobody asked for.
    const p = resolveRiskPosture(prefs({}), PID, { tagOverride: "risk:iterate" });
    expect(p.source).toBe("issue_tag");
    expect(p.gateTier).toBe("impact");
    expect(resolveBaseSweepIntervalMs(p)).toBeNull();
  });
});

describe("describeBaseSweep — the effective cadence as one wire struct (#1031)", () => {
  it("reports a scheduled sweep with its interval, posture and a human reason", () => {
    const p = resolveRiskPosture(prefs({ [riskPosturePrefKey(PID)]: "standard" }), PID);
    const info = describeBaseSweep(p, "2026-09-04T00:00:00.000Z");
    expect(info).toMatchObject({
      scheduled: true,
      intervalMs: 12 * 60 * 60 * 1000,
      nominalIntervalMs: 12 * 60 * 60 * 1000,
      postureLevel: "standard",
      postureSource: "risk_posture",
      nextDueAt: "2026-09-04T12:00:00.000Z",
    });
    expect(info.reason).toContain("12 h");
    expect(info.reason).toContain("standard");
  });

  it("reports NOT scheduled for an unchosen posture, but still names the nominal cadence", () => {
    const info = describeBaseSweep(resolveRiskPosture(prefs({}), PID), "2026-09-04T00:00:00.000Z");
    expect(info.scheduled).toBe(false);
    expect(info.intervalMs).toBeNull();
    expect(info.nextDueAt).toBeNull();
    expect(info.nominalIntervalMs).toBe(12 * 60 * 60 * 1000);
    expect(info.postureSource).toBe("default");
    expect(info.reason).toContain("opt-in");
  });

  it("a risk: tag does not schedule a sweep, and says so", () => {
    const info = describeBaseSweep(resolveRiskPosture(prefs({}), PID, { tagOverride: "risk:iterate" }));
    expect(info.scheduled).toBe(false);
    expect(info.postureSource).toBe("issue_tag");
    expect(info.reason).toContain("tag");
  });

  it("nextDueAt is null without a prior probe or with an unparseable timestamp", () => {
    const p = resolveRiskPosture(prefs({ [riskPosturePrefKey(PID)]: "fast" }), PID);
    expect(describeBaseSweep(p).nextDueAt).toBeNull();
    expect(describeBaseSweep(p, "not-a-date").nextDueAt).toBeNull();
  });

  it("formatIntervalHuman prefers whole hours, then minutes", () => {
    expect(formatIntervalHuman(30 * 60 * 1000)).toBe("30 min");
    expect(formatIntervalHuman(6 * 60 * 60 * 1000)).toBe("6 h");
    expect(formatIntervalHuman(24 * 60 * 60 * 1000)).toBe("24 h");
    expect(formatIntervalHuman(90 * 1000)).toBe("90 s");
  });
});

// @covers preferences-config.resolve.risk-posture [config,risk]
describe("red-base policy under iterate, and the report policy (#1233)", () => {
  it("iterate files a heal ticket instead of holding the train window — and says so", () => {
    const p = resolveRiskPosture(prefs({ [riskPosturePrefKey(PID)]: "iterate" }), PID);
    expect(p.redBasePolicy).toBe("allow-file-debt-ticket");
    // Visibility rule: the summary names the softening, so every gate/merge message carries it.
    expect(p.summary).toContain("heal ticket");
  });

  it("standard and strict keep blocking on a red base", () => {
    for (const level of ["standard", "strict"] as const) {
      expect(resolveRiskPosture(prefs({ [riskPosturePrefKey(PID)]: level }), PID).redBasePolicy).toBe("block");
    }
  });

  it("report ranks softest — below every other policy, and `flow` (#1240) is the only level that resolves it", () => {
    const ranks = Object.entries(RED_BASE_POLICY_RANK) as Array<[RedBasePolicy, number]>;
    const softest = ranks.reduce((a, b) => (b[1] > a[1] ? b : a));
    expect(softest[0]).toBe("report");
    expect(new Set(ranks.map(([, r]) => r)).size).toBe(ranks.length);
    for (const level of ["strict", "standard", "iterate", "fast", "sprint"] as const) {
      expect(resolveRiskPosture(prefs({ [riskPosturePrefKey(PID)]: level }), PID).redBasePolicy).not.toBe("report");
    }
    expect(resolveRiskPosture(prefs({ [riskPosturePrefKey(PID)]: "flow" }), PID).redBasePolicy).toBe("report");
  });

  it("report is reachable as a softer-only override, and never as a tightening", () => {
    const softened = resolveRiskPosture(
      prefs({ [riskPosturePrefKey(PID)]: "sprint", [redBasePolicyPrefKey(PID)]: "report" }),
      PID,
    );
    expect(softened.redBasePolicy).toBe("report");
    expect(softened.summary).toContain("'report' per project override");
    // An `iterate` project asking for `block` keeps its level's own policy — the override is
    // softer-only, so a tightening is ignored (with a warning), never honoured.
    const ignored = resolveRiskPosture(
      prefs({ [riskPosturePrefKey(PID)]: "iterate", [redBasePolicyPrefKey(PID)]: "block" }),
      PID,
    );
    expect(ignored.redBasePolicy).toBe("allow-file-debt-ticket");
  });
});
