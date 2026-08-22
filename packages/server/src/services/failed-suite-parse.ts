/**
 * Which test SUITES did a verify run report as failed (#681 half B)?
 *
 * The base-branch health probe already runs the project's whole `verify_script` and stores a
 * 40-line tail of the output. That tail answers "was it red", which is the question that let
 * `console-tag-ratchet` sit broken for ~26 days and the #614 time-spelling ratchet go red for
 * 47.9 h across 144 commits: a run that is red for the same reason every night and a run that
 * is red for a new reason look identical from the outside. The distinguishing fact is WHICH
 * suite, and it is already printed — just thrown away.
 *
 * So this parses the FULL output (before the tail) into a set of suite paths. It is a
 * heuristic over a human-facing format, and it is treated as one: an empty result on a red run
 * means "this runner's output was not attributable", never "nothing failed". The caller stores
 * `[]` only when it actually has a per-suite verdict — see the `failed_suites` column comment.
 *
 * Two distinctions carry that promise, and both were wrong until #710:
 *   - a red run whose output NEVER ATTRIBUTES A FAILURE is `null`, even when a `Test Files`
 *     summary makes it look like a runner spoke. The derived verify command is
 *     `chainAll(typecheck, test, build)`, so a build-stage failure follows a fully green
 *     vitest run — and `[]` there would clear every suite's rot streak on a run that saw no
 *     suite fail at all;
 *   - a path is only attributed when it is the token FOLLOWING a failure marker. This repo is
 *     full of ratchet tests whose NAMES cite file paths, and "a false name is worse than no
 *     name" — a `×` line reading `parses paths in src/__tests__/other.test.ts correctly`
 *     names no suite.
 */

/**
 * A path that ends in a test-file extension. Anchoring on the EXTENSION rather than on
 * vitest's prefix is what makes this survive the three shapes vitest prints a failing file in
 * (`FAIL <path> > <test>`, `❯ <path> (n tests | m failed)`, and `originated in "<path>" test
 * file`) plus the bracketed collect-error form, without a regex per shape. WHERE it may appear
 * is constrained separately, by the marker-anchored patterns below.
 */
const TEST_PATH = String.raw`[\w./\\@-]*[\w@-][/\\][\w./\\@-]*\.(?:test|spec)\.[cm]?[jt]sx?`;

/**
 * Lines that name a test file WITHOUT claiming it failed. `✓`/`↓` are vitest's pass/skip
 * markers, and the `Test Files`/`Tests` summary lines can carry a path in some reporters.
 * Missing one of these would report a passing suite as rotted, which is worse than reporting
 * nothing: the whole point of the alarm is that someone acts on the suite it names.
 */
const NON_FAILING_LINE = /^\s*(?:[✓√↓·]|Test Files\b|Tests\b|Duration\b|Start at\b)/;

/**
 * Lines that attribute a failure — the marker or keyword that says "something here failed",
 * whether or not it goes on to name a file.
 */
const FAILURE_ATTRIBUTING_LINE = /(?:^|\s)(?:FAIL\b|❯|×|✗|✘)|originated in ["'][^"']+["'] test file/;

/**
 * A per-file count clause, e.g. `(12 tests | 3 failed)`. `0 failed` is a file vitest merely
 * *mentions* in its summary — matching the marker without reading the count is how a green
 * file got attributed.
 */
const FAILED_COUNT = /\|\s*(\d+)\s+failed\b/;

/**
 * The path must be the token that FOLLOWS the marker (`FAIL <path>`, `FAIL [ <path> ]`,
 * `❯ <path>`, `× <path>`), not merely present somewhere on the line.
 */
const MARKER_PATH = new RegExp(String.raw`(?:^|\s)(?:FAIL\b|❯|×|✗|✘)\s+\[?\s*(` + TEST_PATH + `)`);

/** vitest's worker-crash attribution, where the path is quoted. */
const ORIGINATED_PATH = new RegExp(String.raw`originated in ["'](` + TEST_PATH + `)["'] test file`);

/**
 * `true` when the output looks like a test runner's at all — i.e. when an EMPTY failed-suite
 * list is a real verdict ("no suite was named") rather than an absence of information.
 *
 * A verify run that dies in `tsc` or `check:arch` before vitest starts is red with no suite
 * involved; recording `[]` for it would break every suite's red streak on a run that never
 * exercised a single suite, which is precisely the "inferring it passed from a row that never
 * looked" failure the column comment warns about.
 *
 * Necessary but NOT sufficient for a red probe — see `outputHasFailureAttribution`.
 */
export function outputHasSuiteVerdicts(output: string): boolean {
  return /^\s*Test Files\b/m.test(output) || /(?:^|\s)(?:FAIL|PASS)\s+\S+\.(?:test|spec)\./m.test(output);
}

/**
 * `true` when some line actually attributes a failure — the other half of "is an empty list a
 * verdict here".
 *
 * A `Test Files 680 passed` summary followed by a build-stage error satisfies
 * `outputHasSuiteVerdicts` while saying nothing about any failing suite: the runner spoke, but
 * not about the stage that failed. That output must yield `null`, not `[]`.
 */
export function outputHasFailureAttribution(output: string): boolean {
  return output.split(/\r?\n/).some((line) => lineAttributesFailure(line));
}

/** Does this one line claim a failure? (Shared by the attribution check and the parser.) */
function lineAttributesFailure(line: string): boolean {
  if (NON_FAILING_LINE.test(line)) return false;
  const counted = FAILED_COUNT.exec(line);
  if (counted && Number(counted[1]) === 0) return false;
  return FAILURE_ATTRIBUTING_LINE.test(line);
}

/** Normalise to repo-relative-looking forward-slash form so the same suite compares equal across probes. */
function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * The failed suite paths named by a verify run's output, deduped and sorted.
 *
 * Sorted because the result is persisted and then compared across probes: a set whose order
 * depends on which line vitest happened to print first would make two identical verdicts look
 * different to any reader diffing the stored rows.
 *
 * A line that attributes a failure but names no path contributes nothing — that is a real
 * empty verdict, not a reason to go looking for a path elsewhere on the line.
 */
export function parseFailedSuites(output: string): string[] {
  const found = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (!lineAttributesFailure(line)) continue;
    const match = MARKER_PATH.exec(line) ?? ORIGINATED_PATH.exec(line);
    if (match) found.add(normalize(match[1]));
  }
  return [...found].sort();
}

/**
 * The value to persist in `base_branch_health.failed_suites` for one probe.
 *
 * `null` for a probe that cannot speak about suites — `timeout` (the run was cut off, so any
 * suite after the cut is unjudged) and `unverified` (the clone never even installed). `[]` for
 * a green run, which is the value that BREAKS a red streak.
 *
 * A red run yields `null` unless its output both looks like a runner's AND attributes a
 * failure. So `tsc` dying before vitest, and a build stage failing after a green vitest run,
 * are both "not attributable" — only a run that named a failure may return `[]`, and then it
 * means "the runner named the failure but not the file".
 */
export function failedSuitesForOutcome(
  outcome: "green" | "red" | "timeout" | "unverified",
  output: string,
): string[] | null {
  if (outcome === "green") return [];
  if (outcome !== "red") return null;
  if (!outputHasSuiteVerdicts(output)) return null;
  if (!outputHasFailureAttribution(output)) return null;
  return parseFailedSuites(output);
}
