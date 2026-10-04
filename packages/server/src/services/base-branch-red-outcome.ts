/**
 * The red half of the base/rc sweep (`base-branch-health.service.ts`): turn a failed
 * `verify_script` run into the final verdict, with at most one targeted flake retry (#1110) and
 * the full-log evidence a red must carry (#1303). Split out of the service at #1303, when that
 * evidence pushed the service past the 1000-line god-module ceiling.
 */
import type { BaseBranchVerifyResult } from "./base-branch-health.service.js";
import { type FailedSuite, decideFlakeRetry, parseFailedSuites as parseFlakeRetrySuites, retryScopeEnvValue } from "./verify-flake-retry.js";
import { type FailedSuiteClassification, classifyFailedSuites } from "./verify-failed-suites.js";
import { failedSuitesForOutcome } from "./failed-suite-parse.js";
import { summarizeVerifyFailure } from "./verify-failure-summary.js";
import { type PackageTestLister, checkoutTestLister, findUnreportedSuites } from "./verify-unreported-suites.js";

/** What a retry run reports — the shape `runSetupScript` returns, narrowed to what this needs. */
export interface RetryRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/**
 * The failing suites in the form `decideFlakeRetry` needs: attributed to a package (#1242, and
 * this ticket's own follow-up — mirrors `attributeForRetry` in `verify-retry-strategies.ts`,
 * which the pre-merge gate already applies).
 *
 * Vitest 4 prints its `FAIL` summary on stderr and the runner's `[test:mine] <pkg>:` headers on
 * stdout, so on `stderr + "\n" + stdout` text every FAIL line precedes every header and the
 * header-based parse in `verify-flake-retry.ts` labels nothing — which made the base/rc sweep
 * refuse every retry on this repo's own output. `classifyFailedSuites` places each unlabelled
 * suite by which single `packages/<pkg>/` holds it ON DISK (the probe clone's checkout, `dest`),
 * which is available here because the sweep clones the branch before running verify. A suite it
 * cannot place (ambiguous across packages, or `workingDir` absent) keeps its null label, so
 * `decideFlakeRetry` refuses it for the reason it always had.
 */
function attributeForRetry(
  parsed: FailedSuite[],
  classify: (suites: FailedSuite[]) => FailedSuiteClassification,
): { suites: FailedSuite[]; guardSuites: string[] } {
  const classified = classify(parsed);
  const suites = parsed.map((suite) => {
    if (suite.packageLabel) return suite;
    const file = suite.file.replace(/\\/g, "/").replace(/^\.\//, "");
    const placed = classified.files.find((f) => f.endsWith(`/${file}`));
    const m = placed ? /^packages\/([^/]+)\//.exec(placed) : null;
    return m ? { packageLabel: m[1]!, file } : suite;
  });
  return { suites, guardSuites: classified.guardSuites };
}

/**
 * A run's `verify_script` failed — decide the final verdict, applying at most one targeted
 * flake retry (#1110, the base-health twin of the pre-merge gate's #894 retry — see
 * `verify-retry-strategies.ts` for the fuller version this mirrors, minus its install retry,
 * which has no analogue here since the clone is already installed before this is reached).
 *
 * A standalone function rather than inline branches in the caller so the verdict is built by a
 * single `return`, not by mutating an outer `result` across nested `if`s — the shape
 * `runBaseBranchProbe`'s own `let result` assignment already relies on, one level up.
 *
 * `runRetry` is injected (rather than this function spawning the retry itself) so it is testable
 * without a real worktree or verify chain — the same shape `resolveVerifyOutcome` in
 * `verify-retry-strategies.ts` uses for exactly this reason.
 */
export async function resolveRedProbeOutcome(input: {
  projectId: string;
  sha: string;
  branch: string;
  exitCode: number | null;
  combined: string;
  startedAt: number;
  /** Whether this project's verify_script honours `KANBAN_RETRY_TEST_FILES` at all. */
  scoped: boolean;
  runRetry: (retryScopeEnv: string) => Promise<RetryRunResult>;
  /**
   * The probe clone's checkout root, so failing suites can be attributed by DISK the same way
   * the pre-merge gate does (#1242 follow-up). Absent means header-only attribution, same as
   * before this fix.
   */
  workingDir?: string | null;
  /** Injected for tests; defaults to `classifyFailedSuites(workingDir, suites)`. */
  classifySuites?: (suites: FailedSuite[]) => FailedSuiteClassification;
  /** Epoch ms for the pure `durationMs` arithmetic below (not persisted) — injected for tests. */
  nowMs?: number;
  /**
   * The primary run's streams, kept apart. When present, a plain red's `message` is built by
   * the pre-merge gate's `summarizeVerifyFailure`: the FULL output goes to a log file named in
   * a `[full verify log: …]` trailer, and failure lines from before the tail are lifted out.
   * `combined` is stderr FIRST, so its 40-line tail is always the end of stdout — and
   * `test:mine` writes its own verdict (a failing package, tree drift) to stderr. Two red
   * sweeps of `rc/20261004-3` recorded only passing suites and `ELIFECYCLE exit 1` that way.
   */
  stdout?: string;
  stderr?: string;
  /** Writes the full log and returns the message; defaults to `summarizeVerifyFailure`. */
  summarizeFailure?: (stdout: string, stderr: string) => string;
  /** Injected for tests; defaults to asking the probe clone's vitest (`checkoutTestLister`). */
  listTests?: PackageTestLister;
}): Promise<BaseBranchVerifyResult> {
  const { projectId, sha, branch, exitCode, combined, startedAt, scoped, runRetry } = input;
  const now = () => input.nowMs ?? Date.now();
  // #1309: a crashed vitest worker leaves no FAIL line, only a file that never reported.
  const failed = parseFlakeRetrySuites(combined);
  const lister = input.listTests ?? (input.workingDir ? checkoutTestLister(input.workingDir) : null);
  const crashed = failed.length === 0 && lister ? findUnreportedSuites(input.stdout ?? combined, lister) : [];
  const parsed = failed.length > 0 ? failed : crashed;
  const cause = crashed.length > 0 ? "were left unreported by a crashed vitest worker" : "failed under load";
  const classify = input.classifySuites ?? ((suites: FailedSuite[]) => classifyFailedSuites(input.workingDir ?? null, suites));
  const attributed = attributeForRetry(parsed, classify);
  const flake = decideFlakeRetry({ ...attributed, timedOut: false, scoped });
  if (flake.retry) {
    const names = flake.suites.map((s) => `${s.packageLabel}/${s.file}`).join(", ");
    console.log(
      `[base-branch-health] verify_script failed on ${flake.suites.length} suite(s) for project ${projectId} `
        + `— re-running just those before declaring the base red: ${names}`,
    );
    const retriedNames = flake.suites.map((s) => (s.packageLabel ? `packages/${s.packageLabel}/${s.file}` : s.file));
    const retryRun = await runRetry(retryScopeEnvValue(flake.suites));
    if (retryRun.exitCode === 0 && !retryRun.timedOut) {
      console.log(
        `[base-branch-health] ${flake.suites.length} suite(s) ${cause} and PASSED on a targeted `
          + `re-run for project ${projectId}: ${names} — recording GREEN (flaky)`,
      );
      return {
        outcome: "green",
        sha,
        branch,
        durationMs: now() - startedAt,
        flaky: true,
        message: `${flake.suites.length} suite(s) ${cause} and passed on a targeted re-run: ${names}`,
        failedSuites: [],
        retried: retriedNames,
      };
    }
    const retryCombined = [retryRun.stderr, retryRun.stdout].filter(Boolean).join("\n").trim();
    return {
      outcome: "red",
      sha,
      branch,
      durationMs: now() - startedAt,
      message: `verify_script failed (exit ${exitCode}) and the same ${flake.suites.length} suite(s) failed `
        + `again on a targeted re-run — this is a real failure, not machine load:\n${tail(retryCombined || combined)}`,
      // Parsed from the UNTAILED output (#681 half B): the failing-suite lines are scattered
      // through a vitest run, and the 40-line tail that becomes `message` routinely keeps
      // none of them.
      failedSuites: failedSuitesForOutcome("red", combined),
      retried: retriedNames,
    };
  }
  const hasStreams = input.stdout !== undefined || input.stderr !== undefined;
  const summarize = input.summarizeFailure
    ?? ((stdout: string, stderr: string) => summarizeVerifyFailure(stdout, stderr, `base-health-${projectId}-${branch}`));
  return {
    outcome: "red",
    sha,
    branch,
    durationMs: now() - startedAt,
    message: hasStreams ? withStderrLead(input.stderr ?? "", summarize(input.stdout ?? "", input.stderr ?? "")) : tail(combined),
    failedSuites: failedSuitesForOutcome("red", combined),
  };
}

/** The runner's own verdict is on stderr; put its last lines ahead of the stdout-ending tail. */
function withStderrLead(stderr: string, summary: string): string {
  const lead = tail(stderr.trim(), 15);
  return lead ? `[stderr, last lines]\n${lead}\n\n${summary}` : summary;
}

/** Keep only the last ~40 lines so a stored/rendered message stays readable. */
export function tail(text: string, lines = 40): string {
  if (!text) return "";
  const arr = text.split(/\r?\n/);
  return arr.slice(Math.max(0, arr.length - lines)).join("\n");
}
