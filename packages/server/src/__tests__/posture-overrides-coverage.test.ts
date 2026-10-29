// @gate:always-run when:packages/server/src/services/**,packages/server/src/startup/**,packages/shared/src/lib/** — reads the posture resolver modules off disk for projectPref declarations
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { POSTURE_OVERRIDE_PREFS } from "../services/posture-overrides.js";

/**
 * #1747 — a per-project pref the posture's consumers read must appear in `detectPostureOverrides`
 * (and so on the chip, `status --watch` and objective.md). This scans the modules that DECLARE
 * those prefs and fails on one that is neither covered nor consciously exempt.
 */
const ROOT = resolve(import.meta.dirname, "../../..");
const RESOLVER_MODULES = [
  "server/src/services/risk-posture.service.ts",
  "server/src/services/guards-at-merge.ts",
  "server/src/services/review-mode-pref.ts",
  "server/src/services/queue-flush.service.ts",
  "server/src/services/posture-overrides.ts",
  "shared/src/lib/merge-train-red-strategy.ts",
];
/** Read by consumers but not a statement about what the posture verifies. */
const EXEMPT = new Set([
  "risk_posture", // the level itself
  "merge_train_agent_fix_max_turns", "merge_train_agent_fix_timeout_ms", "merge_train_agent_fix_cost_cap_usd", // fix-agent caps
  "merge_train_conflict_resolution", // assembly, not verification
]);

describe("posture override coverage (#1747)", () => {
  it("every projectPref a posture resolver declares is reported or exempt", () => {
    const declared = new Set<string>();
    for (const rel of RESOLVER_MODULES) {
      for (const m of readFileSync(resolve(ROOT, rel), "utf8").matchAll(/projectPref\("([a-z_]+)"\)/g)) declared.add(m[1]);
    }
    const covered = new Set<string>(POSTURE_OVERRIDE_PREFS);
    const missing = [...declared].filter((k) => !covered.has(k) && !EXEMPT.has(k));
    expect(missing).toEqual([]);
  });
});
