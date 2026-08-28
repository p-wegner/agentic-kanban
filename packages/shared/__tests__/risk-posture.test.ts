import { describe, expect, it } from "vitest";
import {
  RISK_POSTURES,
  RISK_POSTURE_DEFAULT,
  RISK_POSTURE_DESCRIPTIONS,
  RISK_POSTURE_LABELS,
  readRiskPosture,
  resolveRiskPosture,
  riskPosturePref,
} from "../src/lib/risk-posture.js";

describe("resolveRiskPosture", () => {
  it("resolves each known posture value to itself", () => {
    for (const p of RISK_POSTURES) {
      expect(resolveRiskPosture(p)).toBe(p);
    }
  });

  it("fails closed to the default for unset, unrecognized, or mistyped values", () => {
    expect(resolveRiskPosture(undefined)).toBe(RISK_POSTURE_DEFAULT);
    expect(resolveRiskPosture(null)).toBe(RISK_POSTURE_DEFAULT);
    expect(resolveRiskPosture("")).toBe(RISK_POSTURE_DEFAULT);
    expect(resolveRiskPosture("Fast")).toBe(RISK_POSTURE_DEFAULT);
    expect(resolveRiskPosture("bogus")).toBe(RISK_POSTURE_DEFAULT);
  });

  it("default is standard — today's behaviour, unchanged", () => {
    expect(RISK_POSTURE_DEFAULT).toBe("standard");
  });
});

describe("readRiskPosture", () => {
  it("reads the project-scoped preference via the shared key family", () => {
    const prefMap = new Map([[riskPosturePref.key("proj-1"), "sprint"]]);
    expect(readRiskPosture(prefMap, "proj-1")).toBe("sprint");
  });

  it("falls back to the default for an unrelated or absent project", () => {
    const prefMap = new Map([[riskPosturePref.key("proj-1"), "sprint"]]);
    expect(readRiskPosture(prefMap, "proj-2")).toBe(RISK_POSTURE_DEFAULT);
    expect(readRiskPosture(new Map(), "proj-1")).toBe(RISK_POSTURE_DEFAULT);
  });
});

describe("RISK_POSTURE_LABELS / RISK_POSTURE_DESCRIPTIONS", () => {
  it("declares a label and a non-empty description for every posture", () => {
    for (const p of RISK_POSTURES) {
      expect(RISK_POSTURE_LABELS[p]).toBeTruthy();
      expect(RISK_POSTURE_DESCRIPTIONS[p].length).toBeGreaterThan(10);
    }
  });
});
