import { describe, it, expect } from "vitest";
import { resolveRiskPosture, riskPosturePrefKey } from "./risk-posture.service.js";

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

  it("every posture's summary names what it does relative to standard", () => {
    for (const level of ["strict", "fast", "sprint"] as const) {
      const p = resolveRiskPosture(prefs({ [riskPosturePrefKey(PID)]: level }), PID);
      expect(p.summary.startsWith(`${level}:`)).toBe(true);
    }
  });
});
