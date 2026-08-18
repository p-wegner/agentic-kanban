import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedTempDir, type ManagedTempDir } from "@agentic-kanban/shared/lib/temp-dir";
import { DEFAULT_SETUP_SCRIPT_TIMEOUT_MS, runSetupScript } from "@agentic-kanban/shared/lib/setup-script";
import { runSmokeCheck } from "@agentic-kanban/shared/lib/smoke-check";
import { gradleUserHomeForWorktree } from "@agentic-kanban/shared/lib/gradle-env";
import { isDocsOnlyDiff } from "@agentic-kanban/shared";
import { testPackagesEnvValue } from "@agentic-kanban/shared/lib/changed-packages";
import { revParse } from "@agentic-kanban/shared/lib/git-service";
import { getChangedFileNames } from "./git.service.js";
import type { Database } from "../db/index.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { getProjectSetupScript } from "../repositories/stack-profile.repository.js";
import { getProjectById } from "../repositories/project.repository.js";
import { buildSmokeCheck, getStackProfile, populateVerifyScript, verifyScriptPrefKey } from "./stack-profile.service.js";
import { runUnderBuildGate } from "./jvm-build-gate.js";
import {
  resolveVerifyGateStrategy,
  countAlwaysRunGuardSuites,
  buildGateTierMessage,
  type GateTierInfo,
  type VerifyGateStrategy,
} from "./pre-merge-gate-tier.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * Default verify-gate timeout (#192). The verify gate runs a full build+test suite in a
 * fresh worktree (cold daemon/cache), a materially heavier job than the setup/install
 * script `DEFAULT_SETUP_SCRIPT_TIMEOUT_MS` budgets — so it gets its own, larger default
 * budget rather than sharing the 5-minute setup-script constant. Still overridable per
 * project via `verify_timeout_ms_<projectId>`.
 */
export const DEFAULT_VERIFY_TIMEOUT_MS = 20 * 60 * 1000;

/** Preference key for a per-project override of the verify-gate timeout (ms). */
// #496: built from the registry, so an unregistered prefix is a COMPILE error.
const verifyTimeoutPrefDef = projectPref("verify_timeout_ms");
const verifyMaxWorkersPrefDef = projectPref("verify_max_workers");
const verifyFileScopePrefDef = projectPref("verify_file_scope");

export function verifyTimeoutPrefKey(projectId: string): string {
  return verifyTimeoutPrefDef.key(projectId);
}

/** Bounds a parsed timeout override to something sane: at least 30s, at most 3 hours. */
const MIN_TIMEOUT_MS = 30 * 1000;
const MAX_TIMEOUT_MS = 3 * 60 * 60 * 1000;

async function resolveVerifyTimeoutMs(projectId: string, database: Database): Promise<number> {
  const raw = await getPreference(verifyTimeoutPrefKey(projectId), database).catch(() => null);
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed >= MIN_TIMEOUT_MS && parsed <= MAX_TIMEOUT_MS) return parsed;
  return DEFAULT_VERIFY_TIMEOUT_MS;
}

/**
 * Default vitest worker cap for gate runs (#278). Two forks still overlap I/O-bound
 * suites while leaving the box responsive; the pre-fix default was `cpus/2`.
 */
export const DEFAULT_VERIFY_MAX_WORKERS = 2;

/** Preference key for a per-project override of the verify-gate vitest worker cap. */
export function verifyMaxWorkersPrefKey(projectId: string): string {
  return verifyMaxWorkersPrefDef.key(projectId);
}

/**
 * Preference key for turning the gate's file-level test scoping OFF per project (#278).
 *
 * Defaults to ON. It is a real narrowing of what the gate proves — `vitest related` selects
 * suites by import graph, so a test that exercises a change through a mechanism vitest cannot
 * see (a spawned process, a fixture read off disk) is no longer selected. The filesystem
 * ASSERTION suites, which are the ones that provably cannot be reached by import, are
 * force-run by `scripts/test-mine.mjs` (`ALWAYS_RUN_TESTS`), so the residual gap is narrower
 * than "everything not imported". A project that would rather pay the full suite sets this to
 * "false".
 */
export function verifyFileScopePrefKey(projectId: string): string {
  return verifyFileScopePrefDef.key(projectId);
}

async function resolveVerifyFileScope(projectId: string, database: Database): Promise<boolean> {
  const raw = await getPreference(verifyFileScopePrefKey(projectId), database).catch(() => null);
  return raw?.trim().toLowerCase() !== "false";
}

// `verify_gate_strategy` (the named tier pref), the always-run guard-suite scan, and the
// pass-message builder live in `pre-merge-gate-tier.ts` (#538) — kept out of this file to stay
// under the god-module cohesion ceiling (`max-file-size.test.ts` / `check-god-modules.mjs`).

const MAX_VERIFY_WORKERS = 32;

async function resolveVerifyMaxWorkers(projectId: string, database: Database): Promise<number> {
  const raw = await getPreference(verifyMaxWorkersPrefKey(projectId), database).catch(() => null);
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed >= 1 && parsed <= MAX_VERIFY_WORKERS) return parsed;
  return DEFAULT_VERIFY_MAX_WORKERS;
}

/**
 * Failure-message signature of a verify_script that couldn't even resolve its own
 * tooling because dependencies were never installed (#169 — a worktree whose blocking
 * setup script failed silently proceeds, then fails the verify gate hours later with an
 * opaque "Could not resolve 'vitest/config'"-style error). Matched against the combined
 * stdout+stderr of a failed verify run to decide whether a one-shot install+retry is
 * worth attempting before withholding the merge.
 */
/**
 * Lines in a verify run's output that carry ZERO diagnostic value but reliably occupy the
 * FRONT of the stream (#221): `git init` default-branch hints and CRLF warnings emitted by
 * test fixtures. When the stored gate error was a head slice, these consumed the entire
 * budget and the actual test failure was never visible.
 */
const BENIGN_GIT_NOISE = /^\s*(hint:|warning: in the working copy of .+ (LF|CRLF) will be replaced|warning: (LF|CRLF) will be replaced)/i;

/** How many chars of (noise-filtered) TAIL to keep in the stored gate message (#221). */
const VERIFY_FAILURE_TAIL_CHARS = 1500;

/**
 * Markers of the runner ITSELF crashing (a worker fork died, an unhandled rejection escaped,
 * the process aborted) rather than a test assertion failing (#490). A crash like this reports
 * zero "failed" tests — the suite mid-crash never got to report a result — so a summary that
 * only ever surfaces "N failed" reads as a clean pass when a worker actually died mid-run.
 */
const WORKER_CRASH_SIGNATURE =
  /unhandled (rejection|error|exception)|panicked at|segmentation fault|fatal error|worker (process )?(exited|died|crashed)|terminated unexpectedly|failed to terminate worker|channel closed|out of memory|uncaught exception/i;

/** Vitest's own attribution line for an error that killed a worker mid-file (#490). */
const ORIGINATED_IN_FILE = /originated in ["']([^"']+)["'] test file/gi;

/** Parses vitest's `Test Files  N passed | M failed (T)` summary line, if present. */
function parseTestFilesSummary(body: string): { reported: number; failed: number; total: number } | null {
  const line = body.split(/\r?\n/).find((l) => /^\s*Test Files\b/i.test(l));
  if (!line) return null;
  const totalMatch = line.match(/\((\d+)\)/);
  if (!totalMatch) return null;
  const total = Number.parseInt(totalMatch[1], 10);
  let reported = 0;
  let failed = 0;
  for (const m of line.matchAll(/(\d+)\s+(passed|failed|skipped|todo)/gi)) {
    const count = Number.parseInt(m[1], 10);
    reported += count;
    if (m[2].toLowerCase() === "failed") failed = count;
  }
  return { reported, failed, total };
}

/**
 * Detects a runner CRASH distinct from a real test failure (#490): a non-zero exit whose
 * `Test Files` summary names ZERO failures (or reports fewer files than it started with, or
 * carries a worker-crash marker) — the shape that reads as "flaky, just retry" when it is
 * actually a dead worker that silently ate one or more suites. Never fires when the summary
 * already names real failures — those are a genuine red gate, not this distinct case.
 */
function detectVerifyCrash(body: string): { leadLine: string } | null {
  const summary = parseTestFilesSummary(body);
  if (summary && summary.failed > 0) return null;
  const missing = summary ? summary.total - summary.reported : 0;
  const hasCrashMarker = WORKER_CRASH_SIGNATURE.test(body);
  const errorsLineMatch = body.match(/^\s*Errors\s+(\d+)\s+error/im);
  const hasErrorsLine = Boolean(errorsLineMatch && Number.parseInt(errorsLineMatch[1], 10) > 0);
  if (missing <= 0 && !hasCrashMarker && !hasErrorsLine) return null;

  const namedFiles = Array.from(new Set(Array.from(body.matchAll(ORIGINATED_IN_FILE), (m) => m[1])));
  const parts = ["CRASH: the test runner did not complete normally — this is NOT a clean test failure."];
  if (missing > 0) {
    parts.push(
      namedFiles.length > 0
        ? `${missing} of ${summary!.total} test file(s) never reported a result, including: ${namedFiles.join(", ")}.`
        : `${missing} of ${summary!.total} test file(s) never reported a result (unnamed — no per-file attribution found in the log).`,
    );
  } else if (namedFiles.length > 0) {
    parts.push(`Crash attributed to: ${namedFiles.join(", ")}.`);
  }
  if (hasErrorsLine) parts.push(errorsLineMatch![0].trim());
  if (hasCrashMarker) {
    const markerLine = body.split(/\r?\n/).find((l) => WORKER_CRASH_SIGNATURE.test(l));
    if (markerLine) parts.push(markerLine.trim());
  }
  return { leadLine: parts.join(" ") };
}

/**
 * Build the human-facing summary of a failed verify run (#221): filter known-benign git
 * noise, keep the TAIL (vitest prints failures and its summary at the END), and persist the
 * FULL untruncated output to a log file whose path the message references — so the gate is
 * diagnosable without re-running a 20+ minute suite.
 */
export function summarizeVerifyFailure(
  stdout: string,
  stderr: string,
  workspaceId: string,
  writeLog: (content: string) => string | null = (content) => {
    try {
      // Deterministic per workspace (no timestamp): the latest failure overwrites, and the
      // resulting message stays STABLE so recordGateFailureNote's dedup-by-gateMessage (#170)
      // still recognises an unchanged failure repeating across orchestrator ticks.
      const path = join(tmpdir(), `kanban-verify-${workspaceId}.log`);
      writeFileSync(path, content, "utf8");
      return path;
    } catch {
      return null;
    }
  },
): string {
  const combined = [stderr, stdout].filter(Boolean).join("\n");
  let logPath: string | null = null;
  if (combined) {
    try {
      logPath = writeLog(combined);
    } catch {
      logPath = null;
    }
  }
  const filtered = combined
    .split(/\r?\n/)
    .filter((line) => !BENIGN_GIT_NOISE.test(line))
    .join("\n")
    .trim();
  const body = filtered || combined.trim();
  const tail = body.length > VERIFY_FAILURE_TAIL_CHARS
    ? `…${body.slice(-VERIFY_FAILURE_TAIL_CHARS)}`
    : body;
  // #490: a worker crash's diagnostic lines (unhandled-error markers, the file it was attributed
  // to) can occur ANYWHERE in the log, not just the tail, and the tail itself ends with a
  // passing-looking summary. Lift the crash verdict OUT and put it FIRST, ahead of that summary,
  // instead of leaving it to be scrolled past or truncated away entirely.
  const crash = detectVerifyCrash(body);
  const message = crash ? `${crash.leadLine}\n\n${tail}` : tail;
  return `${message}${logPath ? `\n[full verify log: ${logPath}]` : ""}`;
}

const MISSING_DEPS_SIGNATURE =
  /cannot find module|could not resolve|err_module_not_found|module_not_found|unresolved_import|enoent.*node_modules|command not found|is not recognized as an internal or external command/i;

function looksLikeMissingDepsFailure(output: string): boolean {
  return MISSING_DEPS_SIGNATURE.test(output);
}

/** The workspace fields the pre-merge gate needs. A thin shape so any caller (exit-workflow's
 *  full WorkspaceRow, the monitor's WorkspaceCandidate) can satisfy it. */
export interface PreMergeGateWorkspace {
  id: string;
  workingDir: string | null;
  /**
   * The branch this workspace merges into. Optional (older callers omit it) — when absent,
   * the docs-only smoke skip (#198) simply can't be evaluated and the smoke gate runs as
   * before; this never widens what the gate blocks, only what it can additionally skip.
   */
  baseBranch?: string | null;
}

export interface PreMergeGateResult {
  /** True when the gate approves the merge (passed, or there was nothing configured to check). */
  passed: boolean;
  /** True when no gate applied at all (no verify_script, not a web project) — a clean no-op. */
  skipped: boolean;
  /** Which gate decided the outcome, for logging/diagnostics. */
  stage: "verify" | "smoke" | "none";
  /** Human-readable outcome, suitable for a board comment / log line. */
  message: string;
  /**
   * True when the gate's verdict came from a wall-clock kill, not a completed run
   * (#192). A timed-out verify_script is inconclusive/retryable, NOT proof the code is
   * broken — callers should avoid treating it the same as a genuine red gate (e.g. when
   * deciding whether to surface a "fix the failing build" nudge to an autonomous monitor).
   */
  timedOut?: boolean;
  /**
   * True when this merge was verified by NOTHING because the project has nothing configured to
   * verify with (#377) — distinct from `skipped`, which also covers the deliberate docs-only skip of
   * a project that DOES have a gate.
   *
   * MEASURED motivation: an autonomous fix loop merged 8 tickets into a project that had no
   * `verify_script` pref and an all-null stack profile, one of them carrying a test that could never
   * pass. Master went from 38/38 green to 40 tests with 1 permanently failing and **nothing said
   * anything**, because "no gate configured" and "gate passed" were both reported as `passed: true`
   * with no visible difference. This flag is what makes that state sayable; callers surface it.
   */
  unverified?: boolean;
}

/**
 * The shared #531 verify_script + #791 boot/render smoke quality gate (#821).
 *
 * Runs the project's configured pre-merge checks against a workspace's worktree and returns whether
 * the merge should proceed. This is the single source of truth for the gate; both the review-exit
 * handler (exit-workflow.ts) and the monitor's `auto_merge_in_review` path call it so neither can
 * land unverified/un-rendered code. (Before this extraction the gate lived only in exit-workflow, so
 * the monitor's auto-merge-of-not-ready In-Review workspaces bypassed it entirely.)
 *
 * Contract:
 *  - `verify_script_<projectId>` set → run it in the worktree; a non-zero exit FAILS the gate.
 *  - web project (stack profile `isWeb` + dev command + health URL) → boot + render smoke check;
 *    a failed boot/response FAILS the gate. A harness ERROR (not a failed boot) is NON-FATAL — it
 *    must not block an otherwise-passing merge, so it is swallowed and the gate continues.
 *  - neither configured → `skipped: true, passed: true` (a pure no-op for library/CLI projects).
 *  - a CONFIGURED gate that cannot run because the workspace has no worktree → FAILS the gate
 *    (fail-closed; never approve work we were told to verify but couldn't, mirrors #826).
 *
 * Both heavy invocations run under the build-concurrency gate (#823) so parallel pre-merge checks
 * on a JVM stack don't spawn a daemon storm that starves the backend.
 */
export async function runPreMergeGate(
  workspace: PreMergeGateWorkspace,
  projectId: string,
  database: Database,
): Promise<PreMergeGateResult> {
  // ---- #531 verify_script gate -------------------------------------------------------------
  // A read error here means we can't tell whether a gate is configured — treat as "no verify gate"
  // (never block a merge on a gate-DETECTION error; fail-closed applies only to a CONFIGURED gate
  // that can't RUN). Mirrors projectHasMergeGate's defensive catch.
  let verifyScript = await getPreference(verifyScriptPrefKey(projectId), database).catch(() => null);
  if (!verifyScript || !verifyScript.trim()) {
    // #377 — re-derive ONCE at gate time when nothing is configured. `verify_script` is otherwise
    // only ever derived at REGISTRATION, and a project registered from an empty repo (every
    // pipeline-scaffolded project: the code arrives in later step commits) therefore has no gate
    // forever, however many test suites it later grows. `populateVerifyScript` is idempotent and
    // never clobbers an existing value or writes an empty one, so this can only ever ADD a gate.
    //
    // Honest limit, MEASURED on the project from the ticket: detection reads the repo ROOT only, and
    // that project's `package.json` lives in `src/`, so this recovers nothing there. It closes the
    // common root-layout case; the `unverified` flag below is what covers the rest.
    const project = await getProjectById(projectId, database).catch(() => null);
    if (project?.repoPath) {
      verifyScript = await populateVerifyScript(projectId, project.repoPath, database).catch(() => null);
      if (verifyScript) {
        console.log(`[pre-merge-gate] derived a verify_script for project ${projectId} at gate time — the repo has grown one since registration (#377): ${verifyScript}`);
      }
    }
  }
  const verifyConfigured = Boolean(verifyScript && verifyScript.trim());
  if (verifyConfigured && !workspace.workingDir) {
    // Fail-closed: a gate we were told to run can't run without a worktree (#826).
    return { passed: false, skipped: false, stage: "verify", message: "verify_script configured but workspace has no worktree — cannot verify" };
  }

  // The diff drives two cost decisions below (docs-only skip, package scoping), so read it
  // ONCE here instead of the single late read the smoke gate used to do. An unreadable diff
  // or a missing baseBranch yields `[]`, which every consumer must treat as "I cannot see the
  // diff" (run everything) rather than "the diff is empty" (skip everything).
  const changedFiles = workspace.workingDir && workspace.baseBranch
    ? await getChangedFileNames(workspace.workingDir, workspace.baseBranch).catch(() => [] as string[])
    : ([] as string[]);
  const docsOnly = changedFiles.length > 0 && isDocsOnlyDiff(changedFiles);

  // Populated once verify_script actually runs, so the final message can NAME what ran even on
  // a passing gate (#538) — a level may only weaken verification VISIBLY, so the tier that was
  // actually used must be sayable regardless of outcome.
  let gateTierInfo: GateTierInfo | null = null;

  if (verifyConfigured && workspace.workingDir && docsOnly) {
    // #198 skipped only the SMOKE boot for a docs-only diff while still paying the full
    // verify suite — on this repo that is a ~40-minute build+test run to prove that editing
    // a markdown file did not break the build. `isDocsOnlyDiff` is the same predicate the
    // smoke gate already trusts for the same reason.
    console.log(`[pre-merge-gate] skipping verify_script for workspace ${workspace.id} — diff touches only docs (${changedFiles.length} file(s))`);
  } else if (verifyConfigured && workspace.workingDir) {
    const workingDir = workspace.workingDir;
    const verifyTimeoutMs = await resolveVerifyTimeoutMs(projectId, database);
    // #194: pin this worktree's backend-spawned gradle to the SAME per-worktree
    // GRADLE_USER_HOME the builder itself used, so the verify gate's daemon and the
    // builder's own daemon cooperate instead of landing in the shared default home
    // where a different worktree's build can kill them out from under each other.
    const gradleEnv = { GRADLE_USER_HOME: gradleUserHomeForWorktree(workingDir) };
    // Scope the test half of the gate to the packages the diff can actually affect. Honoured
    // by `scripts/test-mine.mjs`; ignored by any other verify_script, so this is inert for
    // projects that don't use it. `null` (diff unreadable, global config touched, path owned
    // by no package) sets nothing, which means "run every package".
    const testScope = testPackagesEnvValue(changedFiles);
    if (testScope) {
      console.log(`[pre-merge-gate] scoping verify tests to [${testScope}] for workspace ${workspace.id} (${changedFiles.length} changed file(s))`);
    }
    // #231: the verify gate's test processes must NEVER resolve the live board DB. Without an
    // explicit override, `resolveDbLocation` falls through to `~/.agentic-kanban/kanban.db` —
    // the production board — so gate-spawned vitest workers contended with the running server
    // for SQLite locks (six suites pinned at their 60s timeout) and one suite wrote junk
    // projects into real data. An explicit AGENTIC_KANBAN_DIR outranks every on-disk probe.
    // Belt-and-suspenders with db-path.ts's test-throwaway redirect, which covers vitest even
    // when the verify script is invoked outside this gate.
    //
    // #362: creation and removal now live in ONE place. Before this, `mkdtempSync` was called
    // here and the directory was never removed on any path — 710 `kanban-verify-gate-*` dirs
    // over two days, each potentially holding a throwaway SQLite DB. The removal is in a
    // `finally` below rather than before each `return` because this branch has four early
    // returns and grew them one at a time; a per-return `rm` would leak again on the fifth.
    // The `mkdtempSync` fallback is preserved and must NEVER be given a real disposer:
    // falling back means `gateDataDir === tmpdir()`, and removing that would be catastrophic.
    let gateDir: ManagedTempDir;
    try {
      gateDir = createManagedTempDir("kanban-verify-gate-");
    } catch {
      gateDir = { path: tmpdir(), dispose: () => true };
    }
    const gateDataDir = gateDir.path;
    try {
    // #278: cap the gate's vitest fan-out. vitest's default `maxWorkers = cpus/2`
    // under `pool: "forks"` is tuned for a machine doing nothing else; a gate shares
    // the box with the dev server, other worktrees' gates and the agent, and the
    // fan-out then multiplies peak memory + process-spawn pressure until suites time
    // out — which fails the gate and triggers a full retry (#218: 7 failed attempts
    // over 4 days). Honoured by `scripts/test-mine.mjs`; inert for any other
    // verify_script, and unset for interactive runs so `pnpm test:mine` is unchanged.
    const gateMaxWorkers = await resolveVerifyMaxWorkers(projectId, database);
    const isolationEnv = {
      ...gradleEnv,
      AGENTIC_KANBAN_DIR: gateDataDir,
      KANBAN_TEST_MAX_WORKERS: String(gateMaxWorkers),
    };
    // #278 tier 1: narrow the test half from "every suite in the touched packages" to
    // "every suite that imports the changed files". `KANBAN_TEST_PACKAGES` is
    // package-granular, so any diff touching packages/server — most board tickets — still
    // paid the full ~4,165-test server suite. `scripts/test-mine.mjs` turns this into
    // `vitest related <files>`, which is dependency-aware, and still runs the full suite for
    // any in-scope package the diff owns no files in. Only ever set alongside a package
    // scope: when the diff is unreadable or spans un-modelled paths, `testScope` is null and
    // this stays unset too, so ignorance keeps running everything.
    //
    // #538: `verify_gate_strategy` is the named tier an operator sets; `full` disables
    // file-scoping outright regardless of the legacy `verify_file_scope` boolean (a level may
    // only WEAKEN verification visibly, so `full` must actually mean full). `scoped` and
    // `scoped-base-watch` both enable file-scoping today — `scoped-base-watch` additionally
    // implies a base-health backstop once that mechanism exists (tracked separately); until
    // then it behaves identically to `scoped`, which is itself the honest description of what
    // this gate is currently proven to do.
    const gateStrategy = await resolveVerifyGateStrategy(projectId, database);
    const fileScope =
      testScope && gateStrategy !== "full" ? await resolveVerifyFileScope(projectId, database) : false;
    const verifyEnv = testScope
      ? {
          ...isolationEnv,
          KANBAN_TEST_PACKAGES: testScope,
          ...(fileScope && changedFiles.length > 0 ? { KANBAN_TEST_FILES: changedFiles.join(",") } : {}),
        }
      : isolationEnv;
    if (testScope && fileScope && changedFiles.length > 0) {
      console.log(`[pre-merge-gate] file-scoping verify tests to ${changedFiles.length} changed file(s) for workspace ${workspace.id}`);
    }
    gateTierInfo = {
      strategy: gateStrategy,
      packageScoped: Boolean(testScope),
      fileScoped: Boolean(fileScope && changedFiles.length > 0),
      changedFileCount: changedFiles.length,
      guardSuiteCount: countAlwaysRunGuardSuites(workingDir),
      maxWorkers: gateMaxWorkers,
    };
    const runVerify = () =>
      runUnderBuildGate(() =>
        runSetupScript(workingDir, verifyScript!, { timeoutMs: verifyTimeoutMs, env: verifyEnv }).catch((e) => ({
          exitCode: 1,
          stdout: "",
          stderr: String(e),
          timedOut: false,
        })),
      );
    let result = await runVerify();
    if (result.exitCode !== 0) {
      // A wall-clock kill is NOT a build/test failure (#192) — the same commit can be killed
      // now and pass minutes later purely because the build cache warmed up in the meantime.
      // Report it as inconclusive/retryable instead of a red gate, and skip the missing-deps
      // auto-retry below (a timeout carries no signal about missing dependencies).
      if (result.timedOut) {
        return {
          passed: false,
          skipped: false,
          stage: "verify",
          timedOut: true,
          message: `verify_script timed out after ${verifyTimeoutMs}ms — inconclusive (not a build/test failure); merge withheld pending a retry. Increase verify_timeout_ms_${projectId} if this stack's clean build genuinely needs longer.`,
        };
      }
      // #169: a failure that LOOKS like missing dependencies (rather than a real test/build
      // regression) is worth one automatic install+retry before withholding the merge — this
      // is exactly the failure mode a silently-failed worktree setup script produces hours
      // later. Only attempted once, and only when the project has an install command configured.
      const failureOutput = `${result.stderr || ""}\n${result.stdout || ""}`;
      let retried = false;
      if (looksLikeMissingDepsFailure(failureOutput)) {
        const installCommand = await getProjectSetupScript(projectId, database).catch(() => null);
        if (installCommand && installCommand.trim()) {
          console.warn(`[pre-merge-gate] verify_script failed with a missing-deps signature for workspace ${workspace.id} — retrying once after running the project's install command`);
          await runUnderBuildGate(() =>
            runSetupScript(workingDir, installCommand, { timeoutMs: DEFAULT_SETUP_SCRIPT_TIMEOUT_MS, env: gradleEnv }).catch((e) => ({
              exitCode: 1,
              stdout: "",
              stderr: String(e),
              timedOut: false,
            })),
          );
          retried = true;
          result = await runVerify();
        }
      }
      if (result.exitCode !== 0) {
        if (result.timedOut) {
          return {
            passed: false,
            skipped: false,
            stage: "verify",
            timedOut: true,
            message: `verify_script timed out after ${verifyTimeoutMs}ms${retried ? " (after an auto-install retry)" : ""} — inconclusive (not a build/test failure); merge withheld pending a retry. Increase verify_timeout_ms_${projectId} if this stack's clean build genuinely needs longer.`,
          };
        }
        const suffix = retried ? " (retried once after an auto-install; still failing)" : "";
        return {
          passed: false,
          skipped: false,
          stage: "verify",
          message: `verify_script failed (exit ${result.exitCode})${suffix}: ${summarizeVerifyFailure(result.stdout || "", result.stderr || "", workspace.id)}`,
        };
      }
    }
    } finally {
      // Best-effort by design (#352's root cause): on Windows the directory cannot be removed
      // while any surviving grandchild of the verify run still holds it as its cwd. Log it so a
      // recurring failure is visible instead of silently accumulating again; never throw, because
      // a leaked directory must not turn a PASSING gate into a withheld merge.
      if (!gateDir.dispose()) {
        console.warn(`[pre-merge-gate] could not remove gate data dir ${gateDataDir} for workspace ${workspace.id} — a verify child may still hold it as its cwd`);
      }
    }
  }

  // ---- #791 boot/render smoke gate ---------------------------------------------------------
  // Profile load needs no worktree, so detect "gate applies" before checking workingDir.
  let smokeApplies = false;
  try {
    const profile = await getStackProfile(projectId, database);
    const smokeCheck = buildSmokeCheck(profile);
    if (smokeCheck) {
      if (!workspace.workingDir) {
        // Fail-closed: smoke (UI) gate applies but can't run without a worktree (#826).
        return { passed: false, skipped: false, stage: "smoke", message: "smoke/UI gate applies (web project) but workspace has no worktree — cannot verify" };
      }
      // #198: a docs-only diff can never change boot/render behavior, so skip the (expensive,
      // cold-JVM-hostile) smoke boot entirely rather than pay for a check whose outcome can't
      // have changed. `docsOnly` is computed once at the top of the gate from the same diff
      // read — it is false whenever we could not SEE the diff, so an unknown diff still runs
      // the smoke check exactly as before.
      if (docsOnly) {
        console.log(`[pre-merge-gate] skipping smoke check for workspace ${workspace.id} — diff touches only docs (#198)`);
      } else {
        smokeApplies = true;
        const smoke = await runUnderBuildGate(() => runSmokeCheck(workspace.workingDir!, smokeCheck));
        if (!smoke.passed) {
          return { passed: false, skipped: false, stage: "smoke", message: `smoke check failed: ${smoke.message}` };
        }
      }
    }
  } catch (smokeErr) {
    // NON-FATAL: a harness error (not a failed boot) must not block an otherwise-passing merge.
    // Treat as if the smoke gate passed and fall through. (Matches exit-workflow's behavior.)
    console.warn(`[pre-merge-gate] smoke check errored (non-fatal) for workspace ${workspace.id}:`, errorMessage(smokeErr));
  }

  // `verifyRan` — not `verifyConfigured` — because a docs-only diff skips the verify script.
  // Reporting stage "verify" for a run that never happened would write false evidence into
  // `mergeGateStage`, which is exactly the dishonesty #182 set out to remove.
  const verifyRan = verifyConfigured && !docsOnly;
  const ranSomething = verifyRan || smokeApplies;
  // #377 — "nothing is configured" is NOT the same state as "the configured gate was skipped for a
  // docs-only diff", and conflating them is how eight unverified merges went unremarked. A project
  // with no gate at all is `unverified`; a project with a gate that deliberately skipped is not.
  const unverified = !ranSomething && !verifyConfigured;
  return {
    passed: true,
    skipped: !ranSomething,
    stage: ranSomething ? (verifyRan ? "verify" : "smoke") : "none",
    message: ranSomething
      ? buildGateTierMessage(gateTierInfo)
      : docsOnly
        ? `pre-merge gate skipped — docs-only diff (${changedFiles.length} file(s))`
        : "NOT VERIFIED: this project has no verify_script and no smoke check, so nothing checked this merge (#377)",
    ...(unverified ? { unverified: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Merge-gate DECISION token (#943 / arch-review §1.2)
// ---------------------------------------------------------------------------
//
// The gate DECISION — "run the gate now", "the gate already passed this cycle so
// trust the proof", or "deliberately merge without gating" — used to be encoded as a
// single opaque `skipPreMergeGate: boolean` threaded into `doMerge`, and re-implemented
// (or silently absent) in every other merge trigger path. That made "no gate" an
// invisible default and let the monitor's `skipPreMergeGate: true` assert a gate ran
// with nothing to back it (the acknowledged TOCTOU-by-boolean, #943).
//
// A single OWNER (`resolveMergeGate`) now makes that decision for every trigger path,
// driven by an explicit token the caller passes IN:
//   - `run-gate`            → run the verify/smoke gate here and now.
//   - `already-passed`      → the caller ran the gate this cycle; it must hand over
//                             PROOF (timestamp + stage + source), not a bare boolean.
//                             Stale or malformed evidence is REJECTED and the gate
//                             re-runs — closing the TOCTOU-by-boolean shape.
//   - `skip-explicit`       → merge WITHOUT gating, for a documented reason. Makes
//                             every ungated merge a visible, auditable choice.

/** Evidence that the verify/smoke pre-merge gate already ran and PASSED for this worktree state. */
export interface MergeGateEvidence {
  /** ISO timestamp when the gate ran and passed — used for staleness detection. */
  ranAt: string;
  /** Which gate stage produced the pass (verify/smoke/none). */
  stage: PreMergeGateResult["stage"];
  /** Which path ran the gate (for logs/diagnostics), e.g. "monitor-cycle", "review-exit". */
  source: string;
  /**
   * The branch tip the gate actually ran against. When present it is checked against the
   * branch's CURRENT tip, which is strictly stronger than the timestamp: a commit pushed
   * after the gate but merged inside the freshness window used to land on proof that
   * described different code. Optional for back-compat — evidence written before this field
   * existed (or by a caller that cannot resolve it) still validates on age alone.
   */
  branchSha?: string;
  /**
   * The base tip the gate ran against. A moved base means the merge RESULT is no longer the
   * thing that was verified, even though the branch is untouched — this is the case a
   * purely time-based check cannot see, and the reason a merge that waited behind another
   * merge must re-gate rather than trust its pre-lock pass.
   */
  baseSha?: string;
}

/** The current branch/base tips to validate content-keyed evidence against. */
export interface MergeGateShas {
  branchSha?: string;
  baseSha?: string;
}

/**
 * Resolve the branch/base tips for a workspace, for stamping or validating evidence.
 * Never throws — an unresolvable ref yields `undefined`, which degrades evidence to the
 * age-only check rather than failing a merge over a diagnostic read.
 */
export async function resolveMergeGateShas(workspace: PreMergeGateWorkspace): Promise<MergeGateShas> {
  if (!workspace.workingDir) return {};
  const branchSha = await revParse(workspace.workingDir, "HEAD").catch(() => undefined);
  const baseSha = workspace.baseBranch
    ? await revParse(workspace.workingDir, workspace.baseBranch).catch(() => undefined)
    : undefined;
  return { branchSha, baseSha };
}

/**
 * Explicit gate-decision token passed by a merge trigger into the merge executor.
 * Replaces the old opaque `skipPreMergeGate: boolean` (#943).
 */
export type MergeGateToken =
  | { kind: "run-gate" }
  | { kind: "already-passed"; evidence: MergeGateEvidence }
  | { kind: "skip-explicit"; reason: string };

/** Age past which `already-passed` evidence is treated as stale and the gate re-runs. */
export const MERGE_GATE_EVIDENCE_MAX_AGE_MS = 15 * 60 * 1000;

/** The default token: run the gate now. */
export const RUN_GATE: MergeGateToken = { kind: "run-gate" };

/** Construct an `already-passed` token carrying proof the gate ran and passed. */
export function gateAlreadyPassed(evidence: MergeGateEvidence): MergeGateToken {
  return { kind: "already-passed", evidence };
}

/** Construct a `skip-explicit` token: deliberately merge WITHOUT gating, with a documented reason. */
export function gateSkipExplicit(reason: string): MergeGateToken {
  return { kind: "skip-explicit", reason };
}

/** Outcome of resolving a {@link MergeGateToken} against the current worktree/project state. */
export interface ResolvedMergeGate {
  /** Whether the merge may proceed. */
  passed: boolean;
  /** True when the gate actually RAN this time (false for already-passed / skip-explicit). */
  ran: boolean;
  /** Which gate stage decided the outcome. */
  stage: PreMergeGateResult["stage"];
  /** Human-readable outcome, suitable for a board comment / log line. */
  message: string;
  /** How the decision was reached (for logs/tests). */
  decision: "run-gate" | "already-passed" | "skip-explicit" | "run-gate-stale-evidence";
  /** See {@link PreMergeGateResult.unverified} — nothing checked this merge at all (#377). */
  unverified?: boolean;
}

function evidenceIsFresh(evidence: MergeGateEvidence, now: number): boolean {
  const ranAtMs = Date.parse(evidence.ranAt);
  if (Number.isNaN(ranAtMs)) return false;
  const ageMs = now - ranAtMs;
  // Reject future timestamps too (clock skew / fabricated evidence) — anything outside
  // [now - MAX_AGE, now] is not trustworthy proof.
  return ageMs >= 0 && ageMs <= MERGE_GATE_EVIDENCE_MAX_AGE_MS;
}

/**
 * Why content-keying matters more than the clock: the question a merge needs answered is
 * "was THIS code, against THIS base, verified?" — not "was something verified recently".
 * When the evidence names both tips and both still match, the proof describes exactly the
 * state about to be merged and its age is irrelevant, so a long queue wait no longer forces
 * a pointless re-run. When either tip has moved, the proof is void no matter how fresh it is.
 */
function contentMatch(evidence: MergeGateEvidence, current: MergeGateShas | undefined): "match" | "mismatch" | "unknown" {
  if (!current) return "unknown";
  const branchKnown = Boolean(evidence.branchSha && current.branchSha);
  const baseKnown = Boolean(evidence.baseSha && current.baseSha);
  if (!branchKnown && !baseKnown) return "unknown";
  if (branchKnown && evidence.branchSha !== current.branchSha) return "mismatch";
  if (baseKnown && evidence.baseSha !== current.baseSha) return "mismatch";
  // Waiving the age check requires BOTH tips (#239). Branch-only agreement says the code under
  // test is the code being merged, but says nothing about the merge RESULT — and since the gate
  // now runs outside the repo lock, "another merge landed and moved the base" is the common
  // case, not the exotic one. An unpinned base (legacy evidence, a direct workspace, a caller
  // that omitted `baseBranch`) or a base that cannot be resolved at validation time is
  // therefore "unknown": fall back to the age check rather than granting unassessable evidence
  // an unlimited lifetime. Base-only agreement is likewise not a match.
  return branchKnown && baseKnown ? "match" : "unknown";
}

function evidenceIsValid(evidence: MergeGateEvidence | undefined, now: number, current?: MergeGateShas): boolean {
  if (!evidence || typeof evidence.source !== "string" || !evidence.source.trim()) return false;
  // #642: `stage: "none"` is the gate's own word for "nothing ran" — a docs-only skip, an
  // unconfigured verify_script, a projectless workspace. Honouring it as `already-passed`
  // evidence turns a record of NO verification into a merge permit, and because SHA-pinned
  // evidence deliberately waives the age check (see `contentMatch`), that permit never
  // expires. Reject it and let the gate re-decide: for a genuinely docs-only diff the re-run
  // re-skips in milliseconds, so this costs nothing where the skip was legitimate.
  if (evidence.stage === "none") return false;
  const match = contentMatch(evidence, current);
  // Content says the verified state is gone → reject regardless of age.
  if (match === "mismatch") return false;
  // Content pins the exact branch (and base, when known) → age is not evidence of anything.
  if (match === "match") return true;
  // No usable SHAs on either side → fall back to the legacy age-only check.
  return evidenceIsFresh(evidence, now);
}

async function runGateAsResolved(
  workspace: PreMergeGateWorkspace,
  projectId: string | null,
  database: Database,
): Promise<Omit<ResolvedMergeGate, "decision">> {
  // No project → nothing to look up a gate config against; a clean no-op (mirrors the
  // pre-refactor `if (project && ...)` guard in doMerge).
  if (!projectId) {
    return { passed: true, ran: false, stage: "none", message: "no project — no pre-merge gate applies" };
  }
  const gate = await runPreMergeGate(workspace, projectId, database);
  return {
    passed: gate.passed,
    ran: !gate.skipped,
    stage: gate.stage,
    message: gate.message,
    ...(gate.unverified ? { unverified: true } : {}),
  };
}

/**
 * Single OWNER of the pre-merge gate DECISION for every merge trigger path.
 *
 * Resolves the caller's {@link MergeGateToken} into whether the merge may proceed,
 * running the shared {@link runPreMergeGate} only when the token says to (or when an
 * `already-passed` token's evidence is stale/absent — the fail-safe that closes the
 * TOCTOU-by-boolean window). `skip-explicit` and valid `already-passed` tokens return
 * `passed: true` WITHOUT running an (expensive) build/boot again.
 */
export async function resolveMergeGate(args: {
  token: MergeGateToken;
  workspace: PreMergeGateWorkspace;
  projectId: string | null;
  database: Database;
  /** Injectable clock for staleness tests; defaults to Date.now(). */
  now?: number;
  /**
   * Injectable current branch/base tips for content-keyed evidence validation; defaults to
   * reading them from the worktree. Pass this in tests instead of building a real repo.
   */
  currentShas?: MergeGateShas;
}): Promise<ResolvedMergeGate> {
  const { token, workspace, projectId, database } = args;
  const now = args.now ?? Date.now();

  if (token.kind === "skip-explicit") {
    return { passed: true, ran: false, stage: "none", message: `pre-merge gate skipped (explicit): ${token.reason}`, decision: "skip-explicit" };
  }

  if (token.kind === "already-passed") {
    // Resolve the CURRENT tips so the evidence can be checked against the state actually
    // about to merge. `args.currentShas` lets tests pin this without a real repo.
    const currentShas = args.currentShas ?? (await resolveMergeGateShas(workspace));
    if (evidenceIsValid(token.evidence, now, currentShas)) {
      return {
        passed: true,
        ran: false,
        stage: token.evidence.stage,
        message: `pre-merge gate already passed (${token.evidence.source}, stage ${token.evidence.stage}, ran ${token.evidence.ranAt}`
          + `${token.evidence.branchSha ? `, branch ${token.evidence.branchSha.slice(0, 8)}` : ""}`
          + `${token.evidence.baseSha ? `, base ${token.evidence.baseSha.slice(0, 8)}` : ""})`,
        decision: "already-passed",
      };
    }
    // Stale/absent/fabricated proof → do NOT trust it; run the gate now (closes #943 TOCTOU).
    const result = await runGateAsResolved(workspace, projectId, database);
    return { ...result, decision: "run-gate-stale-evidence" };
  }

  const result = await runGateAsResolved(workspace, projectId, database);
  return { ...result, decision: "run-gate" };
}
