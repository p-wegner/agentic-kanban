import { describe, it, expect } from "vitest";
import { refuseSofterRiskTags, riskTagLevel } from "../src/lib/risk-tag-guard";

describe("risk tag guard (#1745)", () => {
  it("refuses a softer tag than the project posture", () => {
    expect(refuseSofterRiskTags(["risk:sprint"], "standard")).toMatch(/softer/);
    expect(refuseSofterRiskTags(["risk:sprint"], undefined)).toMatch(/softer/);
    expect(refuseSofterRiskTags(["risk:flow"], "iterate")).toMatch(/softer/);
  });
  it("allows equal or stricter tags and non-risk tags", () => {
    expect(refuseSofterRiskTags(["risk:standard"], "standard")).toBeNull();
    expect(refuseSofterRiskTags(["risk:strict"], "standard")).toBeNull();
    expect(refuseSofterRiskTags(["risk:sprint"], "sprint")).toBeNull();
    expect(refuseSofterRiskTags(["harness", "risk:bogus"], "strict")).toBeNull();
  });
  it("parses the level", () => {
    expect(riskTagLevel("risk:fast")).toBe("fast");
    expect(riskTagLevel("risk:nope")).toBeNull();
  });
});
