import { describe, expect, it } from "vitest";
import {
  bullseyeActiveAgentsTarget,
  parseBullseyeObject,
  patchStrategyBullseyeJson,
} from "../src/lib/strategy-bullseye-patch.js";

describe("patchStrategyBullseyeJson (#1102)", () => {
  it("mints a Bullseye from seed + patch when none exists, with no invented segments", () => {
    const result = patchStrategyBullseyeJson(undefined, { activeAgentsTarget: 3 }, { backlogFloor: 3, maxNewStartsPerCycle: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(JSON.parse(result.value)).toEqual({ version: 1, backlogFloor: 3, maxNewStartsPerCycle: 3, activeAgentsTarget: 3, segments: [] });
  });

  it("patch wins over seed on the same key", () => {
    const result = patchStrategyBullseyeJson("", { maxNewStartsPerCycle: 1 }, { maxNewStartsPerCycle: 3 });
    expect(result.ok && JSON.parse(result.value).maxNewStartsPerCycle).toBe(1);
  });

  it("keeps every other field of an existing Bullseye, including ones it does not know", () => {
    const raw = JSON.stringify({
      version: 1,
      activeAgentsTarget: 6,
      segments: [{ id: "s", label: "Bugfix", weight: 5 }],
      providerPolicies: [{ id: "p", provider: "claude", profileName: "anth", mode: "fill", model: "opus" }],
      harnessSharePct: 50,
      somethingNew: { nested: true },
    });
    const result = patchStrategyBullseyeJson(raw, { activeAgentsTarget: 2 }, { backlogFloor: 99 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(false);
    const parsed = JSON.parse(result.value);
    expect(parsed.activeAgentsTarget).toBe(2);
    // The seed only applies when minting.
    expect(parsed.backlogFloor).toBeUndefined();
    expect(parsed.providerPolicies[0].model).toBe("opus");
    expect(parsed.somethingNew).toEqual({ nested: true });
    expect(parsed.harnessSharePct).toBe(50);
  });

  it("refuses to overwrite a malformed Bullseye", () => {
    expect(patchStrategyBullseyeJson("{not json", { activeAgentsTarget: 2 })).toEqual({ ok: false, reason: "malformed" });
    expect(patchStrategyBullseyeJson("[1,2]", { activeAgentsTarget: 2 })).toEqual({ ok: false, reason: "malformed" });
  });

  it("drops non-positive and non-finite numbers instead of writing them", () => {
    const result = patchStrategyBullseyeJson(JSON.stringify({ activeAgentsTarget: 4 }), { activeAgentsTarget: 0, maxNewStartsPerCycle: Number.NaN });
    expect(result.ok && JSON.parse(result.value)).toEqual({ activeAgentsTarget: 4 });
  });
});

describe("bullseyeActiveAgentsTarget / parseBullseyeObject", () => {
  it("reads a positive target and nothing else", () => {
    expect(bullseyeActiveAgentsTarget(JSON.stringify({ activeAgentsTarget: 5 }))).toBe(5);
    expect(bullseyeActiveAgentsTarget(JSON.stringify({ segments: [] }))).toBeNull();
    expect(bullseyeActiveAgentsTarget(JSON.stringify({ activeAgentsTarget: 0 }))).toBeNull();
    expect(bullseyeActiveAgentsTarget("garbage")).toBeNull();
    expect(bullseyeActiveAgentsTarget(undefined)).toBeNull();
  });

  it("tells absent from corrupt", () => {
    expect(parseBullseyeObject("  ")).toBeNull();
    expect(parseBullseyeObject("nope")).toBe("malformed");
    expect(parseBullseyeObject("{}")).toEqual({});
  });
});
