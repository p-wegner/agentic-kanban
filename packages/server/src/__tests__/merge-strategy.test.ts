import { describe, expect, it } from "vitest";
import { PREF_MERGE_STRATEGY } from "../constants/preference-keys.js";
import { isAutomaticMergeEnabled, resolveMergeStrategy } from "../startup/merge-strategy.js";

// Inline read to avoid pulling in the DB layer (worktrees lack node_modules).
// We only need to verify the key appears in the whitelist array.
import fs from "node:fs";
import path from "node:path";
const preferenceServiceSrc = fs.readFileSync(
  path.join(import.meta.dirname!, "../services/preference.service.ts"),
  "utf-8",
);

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

  it("is included in the settings whitelist so UI writes persist", () => {
    // The SETTINGS_KEYS array must contain the merge_strategy key (via PREF_MERGE_STRATEGY constant).
    // Regression test for #660 — the key was missing, making the UI selector a silent no-op.
    const settingsKeysBlock = preferenceServiceSrc.match(/export const SETTINGS_KEYS = \[([\s\S]*?)\];/);
    expect(settingsKeysBlock).not.toBeNull();
    // The source uses the constant reference, not the string literal
    expect(settingsKeysBlock![1]).toContain("PREF_MERGE_STRATEGY");
    // Verify the constant value matches what the runtime expects
    expect("merge_strategy").toBe(PREF_MERGE_STRATEGY);
  });
});
