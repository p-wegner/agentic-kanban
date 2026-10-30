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

describe("detectPostureOverrides — consumer prefs (#1747)", () => {
  it("reports guards_at_merge=intersecting on strict", () => {
    const found = detectPostureOverrides(prefs({ [`risk_posture_${P}`]: "strict", [`guards_at_merge_${P}`]: "intersecting" }), P);
    expect(found).toEqual([
      { key: `guards_at_merge_${P}`, label: "guards at merge", value: "intersecting", postureValue: "all" },
    ]);
  });

  it("reports review_mode, train red strategy, flush gate and red base policy", () => {
    const found = detectPostureOverrides(
      prefs({
        [`risk_posture_${P}`]: "strict",
        [`review_mode_${P}`]: "per-train",
        [`merge_train_red_strategy_${P}`]: "agent-fix",
        [`queue_flush_gate_${P}`]: "pnpm typecheck",
        [`red_base_policy_${P}`]: "report",
      }),
      P,
    );
    expect(found.map((o) => o.label).sort()).toEqual(["flush gate", "red base policy", "review mode", "train red strategy"]);
    expect(found.find((o) => o.label === "red base policy")).toMatchObject({ value: "report", postureValue: "block" });
  });

  it("reports nothing when the prefs equal what the posture implies", () => {
    expect(detectPostureOverrides(prefs({ [`risk_posture_${P}`]: "iterate", [`guards_at_merge_${P}`]: "intersecting" }), P)).toEqual([]);
    expect(detectPostureOverrides(prefs({ [`risk_posture_${P}`]: "fast", [`review_mode_${P}`]: "per-train" }), P)).toEqual([]);
  });
});
