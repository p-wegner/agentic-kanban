// @gate:always-run always — scans the packages tree for hand-rolled `red_base_policy_` reads; that
// half has no import edge (mirrors risk-posture-raw-read-ratchet.test.ts, #911/#1015).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { walkPackageSources, packagesRootFrom } from "../../../shared/__tests__/helpers/guard-scan.js";

/**
 * #1015 — `red_base_policy_<projectId>` is the per-project, **softer-only** override of the
 * `redBasePolicy` a risk-posture LEVEL derives (decision 017, Amendment 2026-09-04). It exists
 * so a project can let merges land on a red base without abandoning its level's gate tier,
 * review mode and train sizing.
 *
 * That only holds if the softer-only check runs. A consumer reading the raw key would get the
 * operator's requested value with no direction check at all — i.e. it could silently honour a
 * STRICTER override, or apply a soft one where the posture never meant it to reach. So the key
 * is readable in exactly one place: `resolveRiskPosture` (via `applyRedBasePolicyOverride`).
 * Everything else reads the resolved `RiskPosture.redBasePolicy`.
 *
 * Zero-tolerance substring scan, for the same reason the `risk_posture_` ratchet uses one: the
 * key is always built from a template, so the token is a source substring however the read is
 * formatted, and the literal has no other legitimate meaning.
 */
const packagesRoot = packagesRootFrom(import.meta.dirname!, 3);

const SANCTIONED_FILES = new Set([
  // The resolver itself — the ONE place allowed to build/read the key.
  "packages/server/src/services/risk-posture.service.ts",
  // Registers the prefix in the allow-list table; doesn't READ a key, just names it in a comment.
  "packages/shared/src/lib/dynamic-preference-keys.ts",
  // Doc comment on the `RedBasePolicy` wire type names the pref it can be overridden by; no read.
  "packages/shared/src/types/api/monitor.ts",
  // This guard's own source mentions the literal as the pattern it scans for.
  "packages/server/src/__tests__/red-base-policy-raw-read-ratchet.test.ts",
  // The resolver's own test builds keys via `redBasePolicyPrefKey`, but may name the literal
  // in test descriptions/comments.
  "packages/server/src/services/risk-posture.service.test.ts",
]);

const RAW_READ_RE = /red_base_policy_/;

function offenders(): string[] {
  const found: string[] = [];
  for (const pkgRelDir of ["server/src", "mcp-server/src", "client/src", "shared/src"]) {
    for (const file of walkPackageSources(`${packagesRoot}/${pkgRelDir}`)) {
      const rel = relative(packagesRoot, file).replace(/\\/g, "/");
      const repoRel = `packages/${rel}`;
      if (SANCTIONED_FILES.has(repoRel)) continue;
      if (RAW_READ_RE.test(readFileSync(file, "utf8"))) found.push(repoRel);
    }
  }
  return found;
}

describe("no consumer reads red_base_policy_ directly (#1015)", () => {
  it("finds zero offenders outside the resolver", () => {
    expect(offenders()).toEqual([]);
  });

  it("the scanner actually bites — a planted raw read is caught", () => {
    expect(RAW_READ_RE.test('prefMap.get(`red_base_policy_${projectId}`)')).toBe(true);
    expect(RAW_READ_RE.test('getPreference("red_base_policy_" + projectId)')).toBe(true);
    expect(RAW_READ_RE.test("// unrelated comment about red_debt_max_")).toBe(false);
  });
});
