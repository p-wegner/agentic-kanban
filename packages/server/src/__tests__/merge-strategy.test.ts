import { describe, expect, it } from "vitest";
import { PREF_MERGE_STRATEGY } from "../constants/preference-keys.js";
import { isAutomaticMergeEnabled, resolveMergeStrategy, resolveMergePolicy } from "../startup/merge-strategy.js";
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

describe("#546: resolveMergePolicy is the one owner predicate", () => {
  const prefs = (entries: Record<string, string>) => new Map(Object.entries(entries));

  it("reports no owner when auto_merge is off, whatever the strategy says", () => {
    for (const strategy of ["direct", "monitor", "merge_queue"]) {
      const policy = resolveMergePolicy(prefs({ auto_merge: "false", merge_strategy: strategy }));
      expect(policy.owner).toBe("off");
      expect(isAutomaticMergeEnabled(prefs({ auto_merge: "false", merge_strategy: strategy }))).toBe(false);
    }
  });

  it("names the configured owner, and 'direct' means no automation owns it", () => {
    expect(resolveMergePolicy(prefs({ merge_strategy: "monitor" })).owner).toBe("monitor");
    expect(resolveMergePolicy(prefs({ merge_strategy: "merge_queue" })).owner).toBe("merge_queue");
    expect(resolveMergePolicy(prefs({ merge_strategy: "direct" })).owner).toBe("direct");
    expect(isAutomaticMergeEnabled(prefs({ merge_strategy: "direct" }))).toBe(false);
    expect(isAutomaticMergeEnabled(prefs({ merge_strategy: "monitor" }))).toBe(true);
  });

  it("applies the per-project kill-switch only to the project it names", () => {
    const map = prefs({ merge_strategy: "monitor", "auto_merge_disabled_11111111-1111-1111-1111-111111111111": "true" });
    expect(resolveMergePolicy(map, "11111111-1111-1111-1111-111111111111").allowedForProject).toBe(false);
    expect(resolveMergePolicy(map, "22222222-2222-2222-2222-222222222222").allowedForProject).toBe(true);
    // A global question — no project named — is never blocked by one project's switch.
    expect(resolveMergePolicy(map).allowedForProject).toBe(true);
  });
});
