// @gate:always-run always — scans every package's src tree for hand-rolled `guards_at_merge_`
// reads; that half has no import edge (mirrors red-base-policy-raw-read-ratchet.test.ts, #1232).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { walkPackageSources, packagesRootFrom } from "../../../shared/__tests__/helpers/guard-scan.js";

/**
 * #1232 — `guards_at_merge_<projectId>` overrides the guards mode the project's risk-posture
 * LEVEL derives (`iterate` -> `intersecting`, everything else -> `all`). The derivation, the
 * override and the fail-open on an unparseable value live in ONE resolver
 * (`resolveGuardsAtMerge`, `services/guards-at-merge.ts`); a consumer reading the raw key would
 * get the operator's typed value with none of that — and `intersecting` is the mode that runs
 * LESS, so a raw read is a way to narrow a gate by accident. Everything else reads the resolved
 * `GuardsAtMerge` value the gate hands it.
 *
 * Zero-tolerance substring scan, for the same reason the `risk_posture_` / `red_base_policy_`
 * ratchets use one: the key is always built from a template, so the token is a source substring
 * however the read is formatted, and the literal has no other legitimate meaning.
 */
const packagesRoot = packagesRootFrom(import.meta.dirname!, 3);

const SANCTIONED_FILES = new Set([
  // The resolver itself — the ONE place allowed to build/read the key.
  "packages/server/src/services/guards-at-merge.ts",
  // Registers the prefix in the allow-list table; doesn't READ a key, just names it in a comment.
  "packages/shared/src/lib/dynamic-preference-keys.ts",
  // This guard's own source mentions the literal as the pattern it scans for.
  "packages/server/src/__tests__/guards-at-merge-raw-read-ratchet.test.ts",
  // The resolver's own test builds keys via `guardsAtMergePrefKey` and asserts the literal shape.
  "packages/server/src/__tests__/guards-at-merge.test.ts",
]);

const RAW_READ_RE = /guards_at_merge_/;

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

describe("no consumer reads guards_at_merge_ directly (#1232)", () => {
  it("finds zero offenders outside the resolver", () => {
    expect(offenders()).toEqual([]);
  });

  it("the scanner actually bites — a planted raw read is caught", () => {
    expect(RAW_READ_RE.test('prefMap.get(`guards_at_merge_${projectId}`)')).toBe(true);
    expect(RAW_READ_RE.test('getPreference("guards_at_merge_" + projectId)')).toBe(true);
    expect(RAW_READ_RE.test("// unrelated comment about guards_only_")).toBe(false);
  });
});
