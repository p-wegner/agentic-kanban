import { describe, expect, it } from "vitest";
import { isAutomaticMergeEnabled, resolveMergeStrategy } from "../startup/merge-strategy.js";

describe("merge strategy preferences", () => {
  it("preserves legacy ownership when no explicit strategy is configured", () => {
    expect(resolveMergeStrategy(new Map([["auto_monitor", "true"]]))).toBe("monitor");
    expect(resolveMergeStrategy(new Map([["auto_monitor", "false"]]))).toBe("merge_queue");
  });

  it("disables automatic merging only for the direct strategy or auto_merge=false", () => {
    expect(isAutomaticMergeEnabled(new Map([["merge_strategy", "direct"]]))).toBe(false);
    expect(isAutomaticMergeEnabled(new Map([["merge_strategy", "monitor"], ["auto_merge", "false"]]))).toBe(false);
    expect(isAutomaticMergeEnabled(new Map([["merge_strategy", "merge_queue"], ["auto_merge", "true"]]))).toBe(true);
  });
});
