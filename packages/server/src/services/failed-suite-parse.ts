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
 */

/**
 * A path that ends in a test-file extension, wherever it appears in a line. Anchoring on the
 * EXTENSION rather than on vitest's prefix is what makes this survive the three shapes vitest
 * prints a failing file in (`FAIL <path> > <test>`, `❯ <path> (n tests | m failed)`, and
 * `originated in "<path>" test file`) plus the bracketed collect-error form, without a regex
 * per shape.
 */
const TEST_PATH = /[\w./\\@-]*[\w@-][/\\][\w./\\@-]*\.(?:test|spec)\.[cm]?[jt]sx?/g;

/**
 * Lines that name a test file WITHOUT claiming it failed. `✓`/`↓` are vitest's pass/skip
 * markers, and the `Test Files`/`Tests` summary lines can carry a path in some reporters.
 * Missing one of these would report a passing suite as rotted, which is worse than reporting
 * nothing: the whole point of the alarm is that someone acts on the suite it names.
 */
const NON_FAILING_LINE = /^\s*(?:[✓√↓·]|Test Files\b|Tests\b|Duration\b|Start at\b)/;

/** Lines that attribute a failure to a file. */
const FAILING_LINE = /(?:^|\s)(?:FAIL\b|❯|×|✗|✘)|originated in ["'][^"']+["'] test file/;

/**
 * `true` when the output looks like a test runner's at all — i.e. when an EMPTY failed-suite
 * list is a real verdict ("no suite was named") rather than an absence of information.
 *
 * A verify run that dies in `tsc` or `check:arch` before vitest starts is red with no suite
 * involved; recording `[]` for it would break every suite's red streak on a run that never
 * exercised a single suite, which is precisely the "inferring it passed from a row that never
 * looked" failure the column comment warns about.
 */
export function outputHasSuiteVerdicts(output: string): boolean {
  return /^\s*Test Files\b/m.test(output) || /(?:^|\s)(?:FAIL|PASS)\s+\S+\.(?:test|spec)\./m.test(output);
}

/** Normalise to repo-relative-looking forward-slash form so the same suite compares equal across probes. */
function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * The failed suite paths named anywhere in a verify run's output, deduped and sorted.
 *
 * Sorted because the result is persisted and then compared across probes: a set whose order
 * depends on which line vitest happened to print first would make two identical verdicts look
 * different to any reader diffing the stored rows.
 */
export function parseFailedSuites(output: string): string[] {
  const found = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (NON_FAILING_LINE.test(line)) continue;
    if (!FAILING_LINE.test(line)) continue;
    for (const match of line.matchAll(TEST_PATH)) found.add(normalize(match[0]));
  }
  return [...found].sort();
}

/**
 * The value to persist in `base_branch_health.failed_suites` for one probe.
 *
 * `null` for a probe that cannot speak about suites — `timeout` (the run was cut off, so any
 * suite after the cut is unjudged) and `unverified` (the clone never even installed). `[]` for
 * a green run, which is the value that BREAKS a red streak. Also `null` for a red run whose
 * output carried no runner verdict at all, e.g. a failure in `tsc` before vitest started.
 */
export function failedSuitesForOutcome(
  outcome: "green" | "red" | "timeout" | "unverified",
  output: string,
): string[] | null {
  if (outcome === "green") return [];
  if (outcome !== "red") return null;
  if (!outputHasSuiteVerdicts(output)) return null;
  return parseFailedSuites(output);
}
