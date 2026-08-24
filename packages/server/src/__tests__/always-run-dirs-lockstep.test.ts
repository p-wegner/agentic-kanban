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
import path, { resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  ALWAYS_RUN_TESTS_DIR,
  PACKAGES,
  scanAlwaysRunTests,
  isAlwaysRunMarked,
} from "../../../../scripts/test-mine.mjs";
import {
  ALWAYS_RUN_TESTS_DIRS,
  countAlwaysRunGuardSuites,
} from "../services/pre-merge-gate-tier.js";
import { SCAN_PACKAGES } from "./always-run-marker-ratchet.test.js";

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

  /**
   * #647 item 6 — there are THREE lists describing "where the guard suites live", and nothing
   * held them together: test-mine's (what RUNS), the gate tier's (what is REPORTED), and the
   * marker ratchet's SCAN_PACKAGES (what is ENFORCED). Every pair had drifted at some point,
   * and each drift is silent in the direction that matters — a guard nobody runs, counts, or
   * demands a marker for.
   */
  it("the marker RATCHET scans the same packages test-mine runs (#647)", () => {
    const ratchetDirs = SCAN_PACKAGES.map((p) => norm(p.testsDir).split("/packages/")[1]).sort();
    const mineDirs = testMineScanDirs().map((d) => norm(d).replace(/^packages\//, "")).sort();
    expect(ratchetDirs).toEqual(mineDirs);
  });

  /**
   * The scan must actually REACH nested and non-.ts suites, not merely be configured to.
   * Before #647 both scanners were flat and `.test.ts`-only, so a marker in
   * `mcp-server/src/__tests__/tools/` or in a `.test.mjs` was inert — the worst kind of
   * failure, because the marker LOOKS like protection.
   */
  it("test-mine's scan finds marked suites at depth and beyond .test.ts (#647)", () => {
    const server = scanAlwaysRunTests(resolve(REPO_ROOT, "packages/server"), "src/__tests__") as string[];
    expect(server.length).toBeGreaterThan(0);
    expect(server.some((f) => f.endsWith(".test.mjs"))).toBe(true);
  });

  /**
   * #891 — the DIRECTORIES were held in lockstep; the matching RULE was not.
   *
   * One rule ("is this suite marked always-run?") had six independent implementations, all
   * `source.includes("@gate:always-run")`, which cannot tell a marker from a sentence about
   * markers or from the string used as data. They agreed only because all six were wrong the
   * same way — and the two files being miscounted were the two that guard this mechanism.
   *
   * Four of the six were consolidated onto `isAlwaysRunMarked` by import. The remaining two
   * CANNOT share a module: `scripts/test-mine.mjs` is run by bare `node` with no build step
   * and imports only Node built-ins, while `packages/server` ships only `dist/` and so cannot
   * import a repo-root script without breaking a published install. Two implementations is the
   * floor the packaging allows, so they are bound here by BEHAVIOUR instead of by comment.
   *
   * The fixtures are the two real shapes that were being misclassified.
   */
  describe("the marker RULE is the same on both sides (#891)", () => {
    /** A file that DECLARES the marker, in the house style with a trailing rationale. */
    const DECLARES = "// @gate:always-run - walks the repo tree\nimport {} from \"vitest\";\n";
    /** A file that only MENTIONS it — the `const MARKER` / fixture-text shape. */
    const MENTIONS = 'const MARKER = "// @gate:always-run";\nimport {} from "vitest";\n';

    /** Build a throwaway repo root holding the two fixtures in a scanned guard dir. */
    function repoWithFixtures(): string {
      const root = mkdtempSync(path.join(tmpdir(), "ak-marker-rule-"));
      const dir = path.join(root, "packages", "server", "src", "__tests__");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "declares.test.ts"), DECLARES);
      writeFileSync(path.join(dir, "mentions.test.ts"), MENTIONS);
      return root;
    }

    it("the canonical matcher counts a declaration and not a mention", () => {
      expect(isAlwaysRunMarked(DECLARES)).toBe(true);
      expect(isAlwaysRunMarked(MENTIONS)).toBe(false);
    });

    it("both implementations classify the same fixtures identically", () => {
      const root = repoWithFixtures();
      try {
        // Site 1 — what actually RUNS.
        const run = scanAlwaysRunTests(
          path.join(root, "packages", "server"),
          "src/__tests__",
        ) as string[];
        // Site 2 — what the gate REPORTS as "+N guard suites".
        const reported = countAlwaysRunGuardSuites(root);

        expect(run.map((r) => r.replace(/\\/g, "/"))).toEqual(["src/__tests__/declares.test.ts"]);
        expect(reported).toBe(1);
        expect(reported).toBe(run.length);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    /**
     * The regression this ticket is about: under the old `.includes()` BOTH sides returned 2,
     * agreeing with each other while both counted a file that never declared anything. A count
     * that agrees is not the same as a count that is right.
     */
    it("neither side is fooled by a file that merely mentions the marker", () => {
      const root = mkdtempSync(path.join(tmpdir(), "ak-marker-rule-mention-"));
      try {
        const dir = path.join(root, "packages", "server", "src", "__tests__");
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "mentions-only.test.ts"), MENTIONS);
        expect(
          scanAlwaysRunTests(path.join(root, "packages", "server"), "src/__tests__"),
        ).toEqual([]);
        expect(countAlwaysRunGuardSuites(root)).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
