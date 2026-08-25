/**
 * Re-run the suites that failed, before calling the gate red (#894).
 *
 * THE MEASURED PROBLEM: workspace #846 ran its pre-merge gate FIFTEEN times and merged zero
 * times, on a diff of `package.json` plus one test file. Each run was the full suite — 764
 * files, 7,183 tests, 26-44 minutes. The last recorded failure was **3 tests out of 7,183**
 * (0.04%), all three timing-shaped:
 *
 *     FAIL src/__tests__/mock-agent-multiturn.test.ts    "mock-agent timed out"
 *     FAIL src/__tests__/session-lifecycle.test.ts       expected 1 to be >= 2
 *     FAIL src/__tests__/shared-package-exports.test.ts  "Test timed out in 90000ms"
 *
 * Re-running exactly those three on an idle box took **21.9 seconds and all 33 tests
 * passed**. `shared-package-exports` blew a 90-second timeout during the gate and finished
 * in ~22s when the machine was quiet — a >4x swing driven purely by machine state. So the
 * verdict "this branch is not safe to merge" was produced by contention, not by the diff.
 *
 * WHY IT COULD NOT CONVERGE ON ITS OWN: the retry made the cause worse. A full gate is
 * itself the load that makes the next gate flake, so fifteen attempts is not bad luck, it
 * is a feedback loop. And because each running gate holds `verify_gate_running` across the
 * board, one ticket's flaky gate blocked auto-start for **13 unrelated projects** for
 * 26-44 minutes at a time.
 *
 * WHAT THIS DOES: when a verify run fails with a SMALL, identifiable set of failed suites,
 * re-run only those suites (~22s) instead of discarding a 44-minute run. If they pass, the
 * gate passes. If they fail again, that is a much stronger signal than the first failure
 * was — a suite that fails twice, the second time nearly alone on the machine, is a real
 * failure rather than a load artefact. Either way the gate has more information than
 * before, for about twenty seconds.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *
 *  - It never retries a BROAD failure. Fifty failing suites is a regression, not a flake,
 *    and re-running them is just the same gate again. The cap is what keeps this a
 *    flake-tolerance mechanism rather than a blanket second chance.
 *  - It never retries what it cannot NAME. If no suite path can be parsed out of the
 *    output — a compile error, an install failure, a crashed runner — there is nothing to
 *    re-run and the failure stands.
 *  - It never retries more than once. The whole point is to stop an unbounded retry loop,
 *    so replacing it with a smaller unbounded retry loop would miss it.
 *  - It never hides that it happened. Per `CLAUDE.md`, a level may only weaken verification
 *    VISIBLY: the caller must name the retry in the gate message on BOTH outcomes, never a
 *    bare "passed".
 *
 * Pure by construction so every case below is a table test.
 */

/** A failed suite, attributed to the package whose vitest run reported it. */
export interface FailedSuite {
  /**
   * Package label as `scripts/test-mine.mjs` prints it (`server`, `client`, `shared`,
   * `mcp-server`). Null when the output gave no package context — see `parseFailedSuites`.
   */
  packageLabel: string | null;
  /** Suite path as vitest printed it: relative to the PACKAGE dir, since that is its cwd. */
  file: string;
}

/**
 * Most failed suites that will still be treated as a possible flake.
 *
 * Five is deliberately low. The observed flake was three, and the cases this exists for are
 * timeouts and timing-sensitive assertions, which come in ones and twos. A double-digit
 * failure is a regression and must reach the operator as one.
 */
export const MAX_RETRYABLE_SUITES = 5;

/**
 * `[test:mine] server: node vitest run …` — the line that tells us which package the FAIL
 * lines below it belong to. Needed because vitest runs with the PACKAGE as cwd, so its
 * `FAIL src/__tests__/x.test.ts` paths are ambiguous across packages on their own: every
 * package has a `src/__tests__`.
 */
const PACKAGE_HEADER = /^\s*\[test:mine\]\s+([a-z0-9@/-]+):/i;

/**
 * A vitest failure line. Matches both the per-test form (`FAIL  src/x.test.ts > name`) and
 * the file-summary form (`FAIL  src/x.test.ts [ src/x.test.ts ]`), and tolerates the ANSI
 * colouring vitest emits when it thinks it has a TTY.
 */
const FAIL_LINE = /(?:^|\s)FAIL\s+(?:\S+\s+)??([\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?)/;

// eslint-disable-next-line no-control-regex -- stripping real ANSI SGR sequences
const ANSI = /\[[0-9;]*m/g;

/**
 * Pull the failing suites out of a verify run's combined output.
 *
 * Order is preserved and duplicates collapsed: vitest names the same file once per failing
 * test and again in its summary, so a single flaky suite would otherwise read as many.
 */
export function parseFailedSuites(output: string): FailedSuite[] {
  const seen = new Set<string>();
  const out: FailedSuite[] = [];
  let currentPackage: string | null = null;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(ANSI, "");
    const header = PACKAGE_HEADER.exec(line);
    if (header) {
      currentPackage = header[1] ?? null;
      continue;
    }
    const failure = FAIL_LINE.exec(line);
    if (!failure) continue;
    const file = failure[1]!.replace(/\\/g, "/");
    const key = (currentPackage ?? "?") + "::" + file;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ packageLabel: currentPackage, file });
  }
  return out;
}

export type FlakeRetryDecision =
  | { retry: true; suites: FailedSuite[]; reason: string }
  | { retry: false; suites: FailedSuite[]; reason: string };

/**
 * Decide whether a failed verify run has earned one narrow re-run.
 *
 * `scoped` says whether the project's verify_script actually honours a suite scope. Only
 * this repo's `scripts/test-mine.mjs` does; for any other project (gradlew, pytest, mvn) the
 * env var is inert and a "retry" would silently re-run the ENTIRE suite — which is the
 * 44-minute operation this exists to avoid, so it must not be attempted at all. This is the
 * same trap `KANBAN_TEST_GUARDS_ONLY` documents at the docs-only skip.
 */
export function decideFlakeRetry(input: {
  output: string;
  /** False when the failure was a timeout — inconclusive already, and handled upstream. */
  timedOut?: boolean;
  /** Whether the verify_script honours suite scoping at all. */
  scoped: boolean;
}): FlakeRetryDecision {
  const suites = parseFailedSuites(input.output);
  if (input.timedOut) {
    return { retry: false, suites, reason: "the run timed out, which is already reported as inconclusive" };
  }
  if (!input.scoped) {
    return {
      retry: false,
      suites,
      reason: "this project's verify_script does not honour suite scoping, so a retry would re-run everything",
    };
  }
  if (suites.length === 0) {
    return {
      retry: false,
      suites,
      reason: "no failing suite could be identified in the output (a compile, install or runner failure has nothing to re-run)",
    };
  }
  // A suite we cannot attribute to a package cannot be re-run correctly: the same relative
  // path exists in several packages, so guessing would run the wrong file and "pass".
  const unattributed = suites.filter((s) => s.packageLabel === null);
  if (unattributed.length > 0) {
    return {
      retry: false,
      suites,
      reason: `${unattributed.length} failing suite(s) could not be attributed to a package, and the same relative path exists in several`,
    };
  }
  if (suites.length > MAX_RETRYABLE_SUITES) {
    return {
      retry: false,
      suites,
      reason: `${suites.length} suites failed, above the ${MAX_RETRYABLE_SUITES}-suite flake ceiling — this reads as a regression, not contention`,
    };
  }
  return {
    retry: true,
    suites,
    reason: `${suites.length} suite(s) failed out of a full run; re-running just those to tell a load artefact from a real failure`,
  };
}

/**
 * The `KANBAN_RETRY_TEST_FILES` value for a retry: `package:file` pairs, comma-separated.
 *
 * Deliberately NOT reusing `KANBAN_TEST_FILES`, which means something different — it takes
 * CHANGED SOURCE files and derives their related tests via `vitest related`. Handing it a
 * test-file path would ask "what tests relate to this test", which is not the question. This
 * variable means "run exactly these suites and nothing else", so it gets its own name.
 */
export function retryScopeEnvValue(suites: FailedSuite[]): string {
  return suites.map((s) => `${s.packageLabel ?? ""}:${s.file}`).join(",");
}
