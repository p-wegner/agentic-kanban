import { describe, expect, it } from "vitest";
import { listAutoMergeDisabledProjectIds, resolveAutoMerge, resolveMergePolicy } from "../src/lib/merge-policy.js";

const P = "0b3f1a2c-4d5e-6789-abcd-ef0123456789";
const Q = "1c4f2b3d-5e6f-4890-bcde-f01234567890";

const map = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe("resolveAutoMerge — one effective answer per project (#1102)", () => {
  it("enabled when auto_merge is on, automation owns merging, and the project has not opted out", () => {
    expect(resolveAutoMerge(map({ auto_merge: "true", merge_strategy: "monitor" }), P)).toMatchObject({
      enabled: true,
      source: "enabled",
      owner: "monitor",
    });
  });

  it("the per-project opt-out turns it off even with the global switch on", () => {
    const prefs = map({ auto_merge: "true", merge_strategy: "monitor", [`auto_merge_disabled_${P}`]: "true" });
    expect(resolveAutoMerge(prefs, P)).toMatchObject({ enabled: false, source: "project_disabled" });
  });

  it("the global switch off turns it off", () => {
    expect(resolveAutoMerge(map({ auto_merge: "false" }), P)).toMatchObject({ enabled: false, source: "global_off", owner: "off" });
  });

  it("names the project opt-out when both are off — that is the one the chip's toggle can change", () => {
    const prefs = map({ auto_merge: "false", [`auto_merge_disabled_${P}`]: "true" });
    expect(resolveAutoMerge(prefs, P).source).toBe("project_disabled");
  });

  it("a `direct` merge strategy reserves merging for a human, so auto-merge is not effective", () => {
    expect(resolveAutoMerge(map({ auto_merge: "true", merge_strategy: "direct" }), P)).toMatchObject({
      enabled: false,
      source: "direct_strategy",
    });
  });

  it("another project's opt-out does not leak", () => {
    const prefs = map({ auto_merge: "true", merge_strategy: "merge_queue", [`auto_merge_disabled_${Q}`]: "true" });
    expect(resolveAutoMerge(prefs, P).enabled).toBe(true);
    expect(resolveAutoMerge(prefs, Q).enabled).toBe(false);
  });

  it("an opt-out value other than \"true\" is not an opt-out (unchanged polarity)", () => {
    const prefs = map({ auto_merge: "true", merge_strategy: "monitor", [`auto_merge_disabled_${P}`]: "false" });
    expect(resolveAutoMerge(prefs, P).enabled).toBe(true);
  });

  it("keeps auto_merge_in_review semantics — reported exactly as the merge policy reports it", () => {
    for (const value of ["true", "false"]) {
      const prefs = map({ auto_merge: "true", merge_strategy: "monitor", auto_merge_in_review: value });
      expect(resolveAutoMerge(prefs, P).autoMergeInReview).toBe(resolveMergePolicy(prefs, P).autoMergeInReview);
    }
  });
});

describe("listAutoMergeDisabledProjectIds", () => {
  it("is exactly the set the monitor and exit workflow used to derive by hand", () => {
    const prefs = map({
      auto_merge: "true",
      [`auto_merge_disabled_${P}`]: "true",
      [`auto_merge_disabled_${Q}`]: "false",
      unrelated_key: "true",
    });
    const handDerived = new Set(
      [...prefs]
        .filter(([key, value]) => key.startsWith("auto_merge_disabled_") && value === "true")
        .map(([key]) => key.replace("auto_merge_disabled_", "")),
    );
    expect(listAutoMergeDisabledProjectIds(prefs)).toEqual(handDerived);
    expect([...listAutoMergeDisabledProjectIds(prefs)]).toEqual([P]);
  });
});
