// @gate:always-run — scans the packages tree for hand-rolled `risk_posture_` reads; that
// half has no import edge (mirrors auto-review-pref.test.ts, #911).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { walkPackageSources, packagesRootFrom } from "../../../shared/__tests__/helpers/guard-scan.js";

/**
 * #911 — every consumer must read the RESOLVED `RiskPosture` struct (`resolveRiskPosture` /
 * `resolveIssueRiskPosture`), never the raw `risk_posture_<projectId>` preference key. This
 * ratchet enforces it, mirroring the zero-tolerance shape `auto-review-pref.test.ts` uses for
 * `auto_review`.
 *
 * A regex substring scan (not an AST pass) is enough here: unlike the STATIC `auto_review`
 * key, `risk_posture_<projectId>` is always built from a template — `risk_posture_${…}` or
 * `` `risk_posture_${…}` `` — so the offending token is a source substring however the read
 * is formatted, and there is no legitimate other meaning of the literal `risk_posture_` to
 * false-positive on.
 */
const packagesRoot = packagesRootFrom(import.meta.dirname!, 3);

const SANCTIONED_FILES = new Set([
  // The resolver itself — the ONE place allowed to build/read the key.
  "packages/server/src/services/risk-posture.service.ts",
  // Registers the prefix in the allow-list table; doesn't READ a key, just names it in a comment.
  "packages/shared/src/lib/dynamic-preference-keys.ts",
  // Doc comment on the RiskPosture wire type names the pref it is resolved from; no read.
  "packages/shared/src/types/api/monitor.ts",
  // This guard's own source mentions the literal as the pattern it scans for.
  "packages/server/src/__tests__/risk-posture-raw-read-ratchet.test.ts",
  // The resolver's own test constructs prefMap keys via `riskPosturePrefKey`, not the raw string —
  // but it may reference the literal in test descriptions/comments.
  "packages/server/src/services/risk-posture.service.test.ts",
]);

const RAW_READ_RE = /risk_posture_/;

function scanPackage(pkgRelDir: string): string[] {
  return walkPackageSources(`${packagesRoot}/${pkgRelDir}`);
}

function offenders(): string[] {
  const found: string[] = [];
  for (const pkgRelDir of ["server/src", "mcp-server/src", "client/src", "shared/src"]) {
    for (const file of scanPackage(pkgRelDir)) {
      const rel = relative(packagesRoot, file).replace(/\\/g, "/");
      const repoRel = `packages/${rel}`;
      if (SANCTIONED_FILES.has(repoRel)) continue;
      const text = readFileSync(file, "utf8");
      if (RAW_READ_RE.test(text)) found.push(repoRel);
    }
  }
  return found;
}

describe("no consumer reads risk_posture_ directly (#911)", () => {
  it("finds zero offenders outside the resolver", () => {
    expect(offenders()).toEqual([]);
  });

  it("the scanner actually bites — a planted raw read is caught", () => {
    // Prove the regex isn't vacuous: it matches the exact shape a raw read would take.
    expect(RAW_READ_RE.test('prefMap.get(`risk_posture_${projectId}`)')).toBe(true);
    expect(RAW_READ_RE.test('prefMap.get("risk_posture_" + projectId)')).toBe(true);
    expect(RAW_READ_RE.test('// unrelated comment about file_contention_')).toBe(false);
  });
});
