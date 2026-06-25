import { describe, expect, it } from "vitest";
import { PREF_MERGE_STRATEGY } from "../constants/preference-keys.js";
import { isAutomaticMergeEnabled, resolveMergeStrategy } from "../startup/merge-strategy.js";
import { SETTINGS_REGISTRY } from "@agentic-kanban/shared/lib/settings-registry";

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

  it("is included in the settings registry so UI writes persist", () => {
    // merge_strategy must be a key in the single settings registry (SETTINGS_KEYS is
    // now DERIVED from it, #903). Regression test for #660 — the key was once missing,
    // making the UI selector a silent no-op.
    expect(Object.keys(SETTINGS_REGISTRY)).toContain("merge_strategy");
    // Verify the constant value matches the registry key the runtime expects.
    expect("merge_strategy").toBe(PREF_MERGE_STRATEGY);
  });
});
