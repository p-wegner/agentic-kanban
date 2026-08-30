/**
 * What to do when `verify_script` comes back non-zero (#169, #192, #894).
 *
 * This is one responsibility with three answers — "inconclusive", "retry, it may not be the
 * code", and "genuinely red" — and it had grown into the middle of `runPreMergeGate`, which
 * the god-module gate flagged at 47 branches. Extracting it is what that gate asks for:
 * relocating a branchy function does not clear the signal, restructuring it does. The two
 * retry strategies belong together because they answer the same question and differ only in
 * the evidence they read:
 *
 *  - **missing deps** (#169): the failure text looks like an unresolved import rather than a
 *    real regression — the shape a silently-failed worktree setup script produces hours
 *    later. Run the project's install command once, then re-run the whole verify.
 *  - **flake** (#894): the run failed on a SMALL, identifiable set of suites, which is the
 *    shape of machine contention rather than of a bad diff. Re-run only those suites.
 *
 * Both are ONE-SHOT by construction: each is attempted at most once per gate, and neither can
 * re-enter the other. That matters more than it looks — #894's whole finding was a retry loop
 * whose retries CAUSED the failure they were retrying (a full gate is itself the load that
 * makes the next gate flake), so a retry mechanism that can iterate would recreate the bug it
 * exists to fix.
 *
 * Everything the caller needs is injected as a callback, so this module reaches no database,
 * spawns no process of its own, and is exercised without a worktree.
 */
import { type FailedSuite, decideFlakeRetry, retryScopeEnvValue } from "./verify-flake-retry.js";

export interface VerifyRunResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  /**
   * Set when the process was killed by the no-progress watchdog (#903) rather than run to
   * completion or wall-clock timed out. Treated the same as `timedOut` here: it carries no
   * signal about missing dependencies or which suites are flaky, so it must skip both retries
   * exactly like a timeout does — otherwise a silently-killed process's (partial, truncated)
   * stdout/stderr gets fed to the missing-deps sniff and the flake-retry "real failure" message
   * as if the run had actually finished and failed.
   */
  noProgress?: boolean;
}

export interface VerifyFailure {
  timedOut?: boolean;
  message: string;
}

export interface VerifyOutcome {
  /** Null when the verify stage ended up passing — possibly only after a retry. */
  failure: VerifyFailure | null;
  /**
   * Set when a targeted re-run cleared load-induced failures. The caller MUST surface it on
   * the passing gate message: a level may only weaken verification visibly, so a merge
   * cleared by a second narrower run must say so.
   */
  flakeRetryNote?: string;
  /**
   * The suites a targeted re-run cleared, structured (not just the prose in `flakeRetryNote`).
   * Set only alongside `flakeRetryNote` — a caller with a red-debt ledger can open a `flaky`
   * entry per suite instead of paying for a full re-run on the next gate too (#915).
   */
  flakySuites?: FailedSuite[];
  /**
   * Every suite this verify stage saw fail, whether or not a retry later cleared it (#954).
   *
   * Distinct from `flakySuites`, which is the narrow subset a targeted re-run PASSED and which
   * therefore says nothing about a run that failed for real. The outcome ledger needs the other
   * question answered — "what failed here" — for both verdicts, because a failure the selection
   * would not have picked is exactly the miss it exists to count, and a red gate is the only kind
   * of run that can contain one.
   *
   * Empty (not undefined) when the run passed first time or when no suite name could be parsed
   * out of the output — a compile, install or runner failure names nothing to attribute.
   */
  failedSuites: FailedSuite[];
}

export interface ResolveVerifyOutcomeInput {
  /** The first run's result. */
  result: VerifyRunResult;
  /** Re-run the full verify script (used after an install). */
  runVerify: () => Promise<VerifyRunResult>;
  /** Re-run the verify script scoped to the named suites (`KANBAN_RETRY_TEST_FILES`). */
  runVerifyWithRetryScope: (retryScope: string) => Promise<VerifyRunResult>;
  /** The project's install command, or null when it has none configured. */
  getInstallCommand: () => Promise<string | null>;
  /** Run the install command. */
  runInstall: (command: string) => Promise<void>;
  /** Does the failure text look like missing dependencies rather than a regression? */
  looksLikeMissingDeps: (output: string) => boolean;
  /** Whether this project's verify_script honours a suite scope at all. */
  scoped: boolean;
  verifyTimeoutMs: number;
  projectId: string;
  workspaceId: string;
  /** Shape a failure's output into the operator-facing summary. */
  summarize: (stdout: string, stderr: string) => string;
  log?: (message: string) => void;
}

const combinedOutput = (r: VerifyRunResult) => `${r.stderr || ""}\n${r.stdout || ""}`;

function timeoutFailure(input: { verifyTimeoutMs: number; projectId: string; afterInstall: boolean }): VerifyFailure {
  // A wall-clock kill is NOT a build/test failure (#192) — the same commit can be killed now
  // and pass minutes later purely because the build cache warmed up in the meantime.
  const suffix = input.afterInstall ? " (after an auto-install retry)" : "";
  return {
    timedOut: true,
    message:
      `verify_script timed out after ${input.verifyTimeoutMs}ms${suffix} — inconclusive (not a build/test ` +
      `failure); merge withheld pending a retry. Increase verify_timeout_ms_${input.projectId} if this ` +
      `stack's clean build genuinely needs longer.`,
  };
}

function noProgressFailure(input: { projectId: string; afterInstall: boolean }): VerifyFailure {
  // Same "inconclusive, not a verdict on the code" contract as a wall-clock timeout (#903) —
  // the process was killed for producing no output, not because it ran and failed.
  const suffix = input.afterInstall ? " (after an auto-install retry)" : "";
  return {
    timedOut: true,
    message:
      `verify_script was killed by the no-progress watchdog${suffix} — inconclusive (not a build/test ` +
      `failure); merge withheld pending a retry. This means the process produced no output for the ` +
      `configured budget, not that the build/tests failed.`,
  };
}

const suiteNames = (suites: FailedSuite[]) => suites.map((s) => `${s.packageLabel}/${s.file}`).join(", ");

/**
 * Decide the verify stage's verdict, applying at most one install retry and at most one
 * targeted flake retry.
 */
export async function resolveVerifyOutcome(input: ResolveVerifyOutcomeInput): Promise<VerifyOutcome> {
  const log = input.log ?? ((m: string) => console.warn(`[pre-merge-gate] ${m}`));
  let result = input.result;
  if (result.exitCode === 0) return { failure: null, failedSuites: [] };
  // A timeout carries no signal about missing dependencies, so it skips both retries. It names no
  // failed suites either: the run was cut off, so anything after the cut is UNJUDGED and reporting
  // whatever happened to have failed before it would be a partial list presented as a whole one.
  if (result.timedOut) {
    return { failure: timeoutFailure({ ...input, afterInstall: false }), failedSuites: [] };
  }
  // Same treatment for a no-progress kill (#903) — it is not evidence about the code either.
  if (result.noProgress) {
    return { failure: noProgressFailure({ ...input, afterInstall: false }), failedSuites: [] };
  }

  // ---- #169 missing-deps install retry ----------------------------------------------------
  let installed = false;
  if (input.looksLikeMissingDeps(combinedOutput(result))) {
    const installCommand = await input.getInstallCommand();
    if (installCommand && installCommand.trim()) {
      log(
        `verify_script failed with a missing-deps signature for workspace ${input.workspaceId} — ` +
          "retrying once after running the project's install command",
      );
      await input.runInstall(installCommand);
      installed = true;
      result = await input.runVerify();
    }
  }
  if (result.exitCode === 0) return { failure: null, failedSuites: [] };
  if (result.timedOut) {
    return { failure: timeoutFailure({ ...input, afterInstall: installed }), failedSuites: [] };
  }
  if (result.noProgress) {
    return { failure: noProgressFailure({ ...input, afterInstall: installed }), failedSuites: [] };
  }

  // ---- #894 targeted flake retry -----------------------------------------------------------
  // `decideFlakeRetry` parses the failed suites in EVERY branch, including the ones where it
  // declines to retry, so `flake.suites` is the answer to "what failed here" regardless of what
  // it decides to do about it — which is what the #954 ledger needs on the non-retry paths too.
  const flake = decideFlakeRetry({ output: combinedOutput(result), timedOut: result.timedOut, scoped: input.scoped });
  const failedSuites = flake.suites;
  if (flake.retry) {
    const names = suiteNames(flake.suites);
    log(
      `verify_script failed on ${flake.suites.length} suite(s) for workspace ${input.workspaceId} — ` +
        `re-running only those to tell contention from a regression: ${names}`,
    );
    const retryResult = await input.runVerifyWithRetryScope(retryScopeEnvValue(flake.suites));
    if (retryResult.exitCode === 0 && !retryResult.timedOut && !retryResult.noProgress) {
      return {
        failure: null,
        flakeRetryNote: `— ${flake.suites.length} suite(s) failed under load and PASSED on a targeted re-run: ${names}`,
        flakySuites: flake.suites,
        // The gate PASSED, but these suites did fail on the way there. The ledger records the
        // pass (that is the verdict) alongside what failed, so a suite that keeps needing a retry
        // is visible as failure history rather than being erased by the retry that cleared it.
        failedSuites,
      };
    }
    if (retryResult.noProgress) {
      return { failure: noProgressFailure({ ...input, afterInstall: installed }), failedSuites };
    }
    // Failed twice, the second time nearly alone on the machine. That is a much stronger
    // signal than the first failure was, and the message says so rather than repeating the
    // first verdict — an operator should not have to re-derive that it was confirmed.
    return {
      failure: {
        message:
          `verify_script failed (exit ${result.exitCode}) and the same ${flake.suites.length} suite(s) failed ` +
          `again on a targeted re-run (${names}) — this is a real failure, not machine load: ` +
          input.summarize(result.stdout || "", result.stderr || ""),
      },
      failedSuites,
    };
  }

  const suffix = installed ? " (retried once after an auto-install; still failing)" : "";
  return {
    failure: {
      message:
        `verify_script failed (exit ${result.exitCode})${suffix}: ` +
        input.summarize(result.stdout || "", result.stderr || ""),
    },
    failedSuites,
  };
}
