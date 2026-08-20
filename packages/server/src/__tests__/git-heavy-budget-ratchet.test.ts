// @gate:always-run — recursively scans the whole server __tests__ tree; imports nothing it checks (#680).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { GIT_HEAVY_TEST_TIMEOUT_MS } from "./helpers/timeouts.js";

/**
 * No git-heavy suite may hand-set a per-test budget BELOW the shared one (#680).
 *
 * A hand-set `}, 40000);` overrides the vitest config budget downward, silently and per test.
 * That is how master came to fail 10 suites / 10 tests with zero code regressions — every one
 * passed in isolation, and several failed on hand-set budgets a fraction of what the suite
 * actually costs under parallel load (`git-prepare-for-review` at 40s for tests that take ~15s
 * solo; `workspace-merge-multirepo-retry` at 120s inside a suite taking 306s).
 *
 * `helpers/timeouts.ts` exists precisely so that budget is decided in ONE place, and #206's note
 * on it already conceded that the fix "could not reach tests that pass their own `{ timeout: N }`".
 * This is what reaches them: those suites are listed here, and a numeric budget in one of them
 * fails this test.
 *
 * Deliberately a LIST rather than a repo-wide ban. A short numeric budget is exactly right for a
 * test asserting that something fails fast, and banning it everywhere would push those to the
 * 240s git-heavy budget where a real hang would take four minutes to surface. The list holds the
 * suites measured as load-flaky; it may grow when another one is measured, and each entry means
 * "this suite's cost is dominated by real git/process work, so it must use the shared budget".
 */
const testsDir = import.meta.dirname!;

/** Suites migrated onto the shared budget by #680, which must not drift back. */
const MUST_USE_SHARED_BUDGET = [
  "git-prepare-for-review.test.ts",
  "workspace-repos-merge.test.ts",
  "workspace-merge-multirepo-retry.test.ts",
  "ancestor-branch-reconciler.test.ts",
  "verify-gate-runner.test.ts",
  "workspace-repos-service.test.ts",
];

/** A trailing per-test/hook budget: `}, 40000);` or `}, 40_000);`. */
const TRAILING_BUDGET = /^\s*\}, (\d[\d_]*)\);\s*$/;
/** The option form: `{ timeout: 40000 }`. */
const OPTION_BUDGET = /timeout:\s*(\d[\d_]*)\b/;

function numericBudgets(file: string): { line: number; ms: number; text: string }[] {
  const out: { line: number; ms: number; text: string }[] = [];
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    // A `timeout:` written INTO a file is a payload for the thing under test, not a vitest
    // budget — `verify-gate-runner` writes `JSON.stringify({ timeout: 60 })` as a gate config.
    // The option-form regex cannot tell the two apart, so payload writers are skipped; the
    // trailing form (`}, N);`) is unambiguous and stays exact.
    if (/JSON\.stringify|writeFile/.test(line)) return;
    for (const re of [TRAILING_BUDGET, OPTION_BUDGET]) {
      const m = line.match(re);
      if (!m) continue;
      out.push({ line: i + 1, ms: Number(m[1].replace(/_/g, "")), text: line.trim() });
    }
  });
  return out;
}

describe("git-heavy budget ratchet (#680)", () => {
  it("the shared budget is large enough to have survived the measured load", () => {
    // 306s was the worst observed suite duration; a per-test budget under ~4 minutes is what
    // produced the false red. Pinned so lowering it back is a deliberate, visible act.
    expect(GIT_HEAVY_TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(240_000);
  });

  it("the listed suites all exist — a rename must not make this vacuous", () => {
    const missing = MUST_USE_SHARED_BUDGET.filter((f) => !fs.existsSync(path.join(testsDir, f)));
    expect(missing, `renamed or deleted; update MUST_USE_SHARED_BUDGET:\n  ${missing.join("\n  ")}`)
      .toEqual([]);
  });

  it("no listed suite hand-sets a numeric per-test budget", () => {
    const offenders: string[] = [];
    for (const name of MUST_USE_SHARED_BUDGET) {
      const full = path.join(testsDir, name);
      if (!fs.existsSync(full)) continue;
      for (const b of numericBudgets(full)) {
        offenders.push(`${name}:${b.line} -> ${b.ms}ms  (${b.text})`);
      }
    }
    expect(
      offenders,
      "These suites are dominated by real git/process work, so their budget must come from " +
        "GIT_HEAVY_TEST_TIMEOUT_MS (helpers/timeouts.ts) rather than a literal — a literal " +
        "overrides the config DOWNWARD per test, which is how #680's false red happened. Replace " +
        `the number with the constant:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("the listed suites actually import the shared budget", () => {
    // Absence of a numeric budget is not proof it is on the shared one — the suite could simply
    // be relying on the config default, which is the other half of what #680 measured.
    const notImporting = MUST_USE_SHARED_BUDGET.filter((name) => {
      const full = path.join(testsDir, name);
      if (!fs.existsSync(full)) return false;
      return !fs.readFileSync(full, "utf8").includes("GIT_HEAVY_TEST_TIMEOUT_MS");
    });
    expect(notImporting, `must use the shared budget:\n  ${notImporting.join("\n  ")}`).toEqual([]);
  });
});
