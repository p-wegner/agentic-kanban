// @gate:always-run
/**
 * #639 — the gate counted a guard suite it structurally could not run.
 *
 * Two lists describe "where do the `@gate:always-run` guard suites live?":
 *   - `ALWAYS_RUN_TESTS_DIR` in `scripts/test-mine.mjs` — decides what actually RUNS.
 *   - `ALWAYS_RUN_TESTS_DIRS` in `pre-merge-gate-tier.ts` — decides what the gate REPORTS
 *     as "+N guard suites" in its pass message.
 *
 * They drifted: the tier scanner had `packages/client/src/__tests__`, test-mine did not. So a
 * file-scoped gate could print "+N guard suites" with the client's marked ratchet counted in N
 * and never execute it. A pass message that overstates what ran is the exact failure the #538
 * tier work exists to prevent, so the two lists are held in lockstep here rather than by
 * comment.
 *
 * This suite reads the repo tree (a script outside its own import graph), hence the marker.
 */
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { ALWAYS_RUN_TESTS_DIR, PACKAGES } from "../../../../scripts/test-mine.mjs";
import { ALWAYS_RUN_TESTS_DIRS } from "../services/pre-merge-gate-tier.js";

const REPO_ROOT = resolve(__dirname, "../../../..");

/** `{label, dir}` → the repo-relative `__tests__` path test-mine would scan. */
function testMineScanDirs(): string[] {
  return PACKAGES.map((pkg: { dir: string; label: string }) =>
    `${pkg.dir}/${ALWAYS_RUN_TESTS_DIR[pkg.label as keyof typeof ALWAYS_RUN_TESTS_DIR]}`,
  );
}

const norm = (p: string) => p.replace(/\\/g, "/");

describe("always-run guard-suite dirs: test-mine vs the gate's tier reporter", () => {
  it("every PACKAGES entry has an ALWAYS_RUN_TESTS_DIR — a missing one silently skipped guards", () => {
    for (const pkg of PACKAGES as { label: string }[]) {
      expect(
        ALWAYS_RUN_TESTS_DIR[pkg.label as keyof typeof ALWAYS_RUN_TESTS_DIR],
        `package "${pkg.label}" is in PACKAGES but has no ALWAYS_RUN_TESTS_DIR entry`,
      ).toBeTruthy();
    }
  });

  it("scans exactly the same directories the gate counts guard suites in", () => {
    expect(testMineScanDirs().map(norm).sort()).toEqual(ALWAYS_RUN_TESTS_DIRS.map(norm).sort());
  });

  it("every scanned directory actually exists in this checkout", () => {
    for (const dir of testMineScanDirs()) {
      expect(existsSync(resolve(REPO_ROOT, dir)), `${dir} does not exist`).toBe(true);
    }
  });
});
