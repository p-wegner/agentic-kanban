import { describe, it, expect } from "vitest";
import { resolveBaseSweepIntervalMs, resolveRiskPosture, riskPosturePrefKey } from "./risk-posture.service.js";

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
    for (const level of ["strict", "iterate", "fast", "sprint"] as const) {
      const p = resolveRiskPosture(prefs({ [riskPosturePrefKey(PID)]: level }), PID);
      expect(p.summary.startsWith(`${level}:`)).toBe(true);
    }
  });
});

// @covers preferences-config.resolve.risk-posture [config,risk]
describe("iterate posture (#983)", () => {
  it("is the ONLY posture that yields the impact gate tier", () => {
    const iterate = resolveRiskPosture(prefs({ [riskPosturePrefKey(PID)]: "iterate" }), PID);
    expect(iterate.gateTier).toBe("impact");

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
    // The nominal cadence of the LEVEL is still 30 min; the resolver is what makes it "never".
    expect(p.sweepIntervalMs).toBe(30 * 60 * 1000);
    expect(resolveBaseSweepIntervalMs(p)).toBeNull();
  });

  it("returns the level's cadence once a posture is explicitly set", () => {
    for (const [level, expected] of [
      ["strict", 12 * 60 * 60 * 1000],
      ["standard", 30 * 60 * 1000],
      ["iterate", 24 * 60 * 60 * 1000],
      ["fast", 6 * 60 * 60 * 1000],
      ["sprint", 24 * 60 * 60 * 1000],
    ] as const) {
      const p = resolveRiskPosture(prefs({ [riskPosturePrefKey(PID)]: level }), PID);
      expect(p.source).toBe("risk_posture");
      expect(resolveBaseSweepIntervalMs(p)).toBe(expected);
    }
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
