// @gate:always-run - requires the scaffold hook via createRequire; not reachable from RISK_POSTURES' import graph.
/**
 * #1244 — `hook-posture.js` claims to mirror `RISK_POSTURES` (`packages/shared/src/lib/
 * risk-posture.ts`) but its own table used to list only `strict`/`standard`/`fast`/`sprint`,
 * so `normalizePosture` silently mapped `iterate` and `flow` (decision 017's 2026-09-24
 * amendments) onto `standard`'s row. Harmless today because both levels want `standard`'s
 * `tests-capacity-gated` builder Stop-chain policy, but a future level with a DIFFERENT
 * policy would be misread by every scaffolded hook, and the header comment claiming
 * parity would be false.
 *
 * `hook-posture.js` cannot `require()` the shared TS module at runtime — it is copied
 * byte-for-byte into a scaffolded worktree's `.claude/hooks/`, outside any build step — so
 * the two tables cannot be unified into one declaration. This test is the lockstep check
 * instead: it iterates the real `RISK_POSTURES` and fails the moment a level is missing
 * from the hook's own `POSTURES` list or `POLICIES` table.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { RISK_POSTURES } from "@agentic-kanban/shared/lib/risk-posture";

// Loaded from the deployed .claude/hooks copy (outside any package.json with
// "type": "module"), the same way hook-posture-policy.test.ts does — requiring the
// packages/server/src/scaffold copy directly fails under this package's ESM setting.
const require = createRequire(import.meta.url);
const HOOK_PATH = resolve(import.meta.dirname, "..", "..", "..", "..", ".claude", "hooks", "hook-posture.js");
const hookPosture = require(HOOK_PATH) as {
  POSTURES: string[];
  POLICIES: Record<string, { typecheck: boolean; tests: boolean; generatedRules: boolean; capacityGated: boolean }>;
  normalizePosture: (v: unknown) => string;
};

describe("hook-posture.js stays in lockstep with RISK_POSTURES (#1244)", () => {
  it("lists every RISK_POSTURES level in its own POSTURES table", () => {
    for (const level of RISK_POSTURES) {
      expect(hookPosture.POSTURES, `POSTURES is missing "${level}"`).toContain(level);
    }
  });

  it("has a POLICIES row for every RISK_POSTURES level", () => {
    for (const level of RISK_POSTURES) {
      expect(hookPosture.POLICIES[level], `POLICIES is missing a row for "${level}"`).toBeDefined();
    }
  });

  it("normalizePosture returns each level unchanged rather than falling through to standard", () => {
    for (const level of RISK_POSTURES) {
      expect(hookPosture.normalizePosture(level), `normalizePosture("${level}")`).toBe(level);
    }
  });

  it("has no stray POLICIES rows for a level RISK_POSTURES no longer has", () => {
    for (const level of Object.keys(hookPosture.POLICIES)) {
      expect(RISK_POSTURES as readonly string[], `POLICIES has a row for unknown level "${level}"`).toContain(level);
    }
  });
});
