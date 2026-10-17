import { describe, expect, it } from "vitest";
import { detectPostureOverrides, formatPostureOverrides } from "../services/posture-overrides.js";

const P = "proj-1";
const prefs = (o: Record<string, string>) => new Map(Object.entries(o));

describe("detectPostureOverrides (#1560)", () => {
  it("reports the leftover flow/iterate tuning that contradicts sprint", () => {
    const found = detectPostureOverrides(
      prefs({
        [`risk_posture_${P}`]: "sprint",
        [`train_max_size_${P}`]: "5",
        [`train_max_wait_ms_${P}`]: "120000",
        [`verify_gate_strategy_${P}`]: "impact",
      }),
      P,
    );
    expect(found.map((o) => o.label)).toEqual(["train size", "train wait", "gate tier"]);
    expect(found[0]).toMatchObject({ value: "5", postureValue: "12", key: `train_max_size_${P}` });
    expect(formatPostureOverrides("sprint", found)).toBe(
      "posture sprint, overridden: train size 5, train wait 120000ms, gate tier impact",
    );
  });

  it("reports nothing when there are no overrides or they equal the posture", () => {
    expect(detectPostureOverrides(prefs({ [`risk_posture_${P}`]: "sprint" }), P)).toEqual([]);
    expect(
      detectPostureOverrides(prefs({ [`risk_posture_${P}`]: "sprint", [`train_max_size_${P}`]: "12" }), P),
    ).toEqual([]);
  });
});
