// @gate:always-run — scans the packages tree for hand-rolled `roster_` / `reserve_allowed_`
// reads; that half has no import edge (mirrors risk-posture-raw-read-ratchet.test.ts, #911).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { walkPackageSources, packagesRootFrom } from "../../../shared/__tests__/helpers/guard-scan.js";

/**
 * #1025 — every consumer must go through the ROSTER RESOLVER (`resolveProjectRoster` /
 * `resolveReserveAllowance` / `resolvePoolExhaustedPct`, reached via the key builders
 * `rosterPrefKey` / `reserveAllowedPrefKey` / `rosterExhaustedPctPrefKey`), never the raw
 * `roster_<projectId>` / `reserve_allowed_<projectId>` preference keys.
 *
 * Why a ratchet and not a convention: the roster's whole value is that ONE place applies
 * the narrowing rule. A second reader that pulls the raw key sees the project's own value
 * WITHOUT the observed global roles narrowed into it — so a globally `forbidden` profile
 * would read as whatever the project wrote, which is exactly the widening the design makes
 * structurally impossible everywhere else.
 *
 * A regex substring scan (not an AST pass) is enough, for the same reason it is in the
 * risk-posture ratchet: these keys are always built from a template, so the offending token
 * is a source substring however the read is formatted.
 */
const packagesRoot = packagesRootFrom(import.meta.dirname!, 3);

const SANCTIONED_FILES = new Set([
  // The resolver and its key builders — the ONE place allowed to build/read these keys.
  "packages/shared/src/lib/profile-roster.ts",
  // The selection half quotes `reserve_allowed_<projectId>` in the hold message it hands the
  // operator ("set reserve_allowed_<projectId>, tag the ticket…"); it reads no preference.
  "packages/shared/src/lib/profile-roster-selection.ts",
  // Registers the prefixes in the allow-list table; names them in a comment, reads nothing.
  "packages/shared/src/lib/dynamic-preference-keys.ts",
  // This guard's own source mentions the literals as the pattern it scans for.
  "packages/server/src/__tests__/roster-raw-read-ratchet.test.ts",
]);

// A READ, not a mention: the key is always built by interpolation or concatenation, so it
// appears as `roster_${…}` or as the quoted literal `"roster_" + id`. Prose in a doc comment
// (`roster_<projectId>`) is neither, which is what keeps the guard about behaviour rather
// than about how a module documents itself.
const RAW_READ_RE = /(?:roster_|reserve_allowed_)[A-Za-z_]*\$\{|["'](?:roster_|reserve_allowed_)[A-Za-z_]*["']/;

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

describe("no consumer reads roster_ / reserve_allowed_ directly (#1025)", () => {
  it("finds zero offenders outside the resolver", () => {
    expect(offenders()).toEqual([]);
  });

  it("the scanner actually bites — a planted raw read is caught", () => {
    expect(RAW_READ_RE.test("prefMap.get(`roster_${projectId}`)")).toBe(true);
    expect(RAW_READ_RE.test('prefMap.get("reserve_allowed_" + projectId)')).toBe(true);
    expect(RAW_READ_RE.test("prefMap.get(`roster_exhausted_pct_${projectId}`)")).toBe(true);
    // Not a raw read: the sanctioned key BUILDER, a doc-comment mention, an unrelated key.
    expect(RAW_READ_RE.test("prefMap.get(rosterPrefKey(projectId))")).toBe(false);
    expect(RAW_READ_RE.test("/** the `roster_<projectId>` value */")).toBe(false);
    expect(RAW_READ_RE.test("// unrelated comment about file_contention_")).toBe(false);
  });
});
