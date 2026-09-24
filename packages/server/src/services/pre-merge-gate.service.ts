import { gateVerificationKey, combinedMergedTreeHash, rememberTreeGatedGreen, wasTreeGatedGreen } from "./merge-gate-tree-memo.js";
import { getAllWorkspaceRepos } from "./workspace-all-repos.js";
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedTempDir, type ManagedTempDir } from "@agentic-kanban/shared/lib/temp-dir";
import { DEFAULT_SETUP_SCRIPT_TIMEOUT_MS, runSetupScript } from "@agentic-kanban/shared/lib/setup-script";
import { runSmokeCheck } from "@agentic-kanban/shared/lib/smoke-check";
import { gradleUserHomeForWorktree } from "@agentic-kanban/shared/lib/gradle-env";
import { isDocsOnlyDiff, isGuardsOnlyDiff } from "@agentic-kanban/shared";
import { testPackagesEnvValue } from "@agentic-kanban/shared/lib/changed-packages";
import { revParse } from "@agentic-kanban/shared/lib/git-service";
import { getChangedFileNames } from "./git.service.js";
import type { Database } from "../db/index.js";
import type { PreMergeGateResult, PreMergeGateWorkspace } from "./pre-merge-gate.types.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { describeOutstandingRepoInstalls } from "./pre-merge-gate-installs.js";
import { describeFailedSetupRun } from "./pre-merge-gate-setup-failure.js";
import { getProjectSetupScript } from "../repositories/stack-profile.repository.js";
import { buildSmokeCheck, getStackProfile, resolveEffectiveVerify } from "./stack-profile.service.js";
import { resolveDevServerPlan } from "./dev-server.service.js";
import type { SmokeCheck, StackProfile } from "@agentic-kanban/shared";
import { resolveProjectDevServerPlan } from "./dev-server.service.js";
import { describeGateHold, quiesceBuildersEnabled, resolveGateHostAdmission } from "./gate-quiesce.js";
import { isSelfProjectRepo } from "./self-project.js";
import { getProjectRepoPath } from "../repositories/project.repository.js";
import { runUnderBuildSemaphore } from "./jvm-build-semaphore.js";
import { runUnderVerifyChainSemaphore, runUnderVerifyChainSemaphoreTimed } from "./verify-chain-semaphore.js";
import { runE2ESmokeGateStage } from "./e2e-smoke-lane.js";
import { noteMergeGatePhase } from "./merge-job.service.js";
import {
  resolveGateVerification,
  resolveVerifyGateStrategy,
  guardFloorFor,
  buildGateTierMessage,
  resolveGateScoping,
  resolveGateFileScopeEmission,
  resolveImpactSelectorEnv,
  buildVerifyEnv,
  guardsOnlyReasonFor,
  type GateTierInfo,
} from "./pre-merge-gate-tier.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { VERIFY_SCRIPT_TIMEOUT_MS } from "./verify-budget.js";
import { beginMergeGateRun, combineGateAbortSignals, endMergeGateRun } from "./merge-cancellation.js";
// #221/#490's failure-message shaping lives in its own module now (this file crossed the
// 1000-line god-module ceiling). Re-exported below so its importers are unchanged.
import { summarizeVerifyFailure } from "./verify-failure-summary.js";
import { VERIFY_NEUTRALIZED_DB_LOCATION_ENV, VERIFY_NEUTRALIZED_LISTENER_ENV } from "../lib/verify-env.js";
import { createSmokeIsolation } from "../lib/smoke-isolation.js";
import { resolveVerifyOutcome } from "./verify-retry-strategies.js";
import type { FailedSuite } from "./verify-flake-retry.js";
import { parseVerifyStepTimings, type VerifyStepTiming } from "./verify-step-timings.js";
import { recordVerifyGateOutcome, resolveGateImpactTierFields } from "./test-impact-outcome.service.js";
import { withFailedSuites } from "./verify-failed-suites.js";
import { buildVerifyResourceEnv } from "./verify-resource-env.js";
import { sequenceBaseHealthBeforeVerify } from "./gate-base-health-sequencing.js";
import { openRedDebtEntry } from "../repositories/red-debt.repository.js";
import { buildStaleVerdictReason } from "./merge-gate-verdict-reason.js";

// The verify TUNABLES (timeout / worker cap / file-scope prefs, and #909's capacity
// derivation) live in `verify-tunables.ts` — same reason as the two extractions above this
// one: this file sits against the 1000-line god-module ceiling. Re-exported so importers,
// including `base-branch-health.service.ts` and `verify-budget-parity.test.ts`, are unchanged.
import {
  DEFAULT_VERIFY_TIMEOUT_MS,
  DEFAULT_VERIFY_MAX_WORKERS,
  verifyTimeoutPrefKey,
  verifyMaxWorkersPrefKey,
  verifyFileScopePrefKey,
  resolveVerifyTimeoutMs,
  resolveVerifyFileScope,
  resolveVerifyMaxWorkers,
  type ResolvedVerifyWorkers,
} from "./verify-tunables.js";

export {
  DEFAULT_VERIFY_TIMEOUT_MS,
  DEFAULT_VERIFY_MAX_WORKERS,
  verifyTimeoutPrefKey,
  verifyMaxWorkersPrefKey,
  verifyFileScopePrefKey,
  resolveVerifyMaxWorkers,
  type ResolvedVerifyWorkers,
};

// `verify_gate_strategy` (the named tier pref), the always-run guard-suite scan, and the
// pass-message builder live in `pre-merge-gate-tier.ts` (#538) — kept out of this file to stay
// under the god-module cohesion ceiling (`max-file-size.test.ts` / `check-god-modules.mjs`).

/**
 * Failure-message signature of a verify_script that couldn't even resolve its own
 * tooling because dependencies were never installed (#169 — a worktree whose blocking
 * setup script failed silently proceeds, then fails the verify gate hours later with an
 * opaque "Could not resolve 'vitest/config'"-style error). Matched against the combined
 * stdout+stderr of a failed verify run to decide whether a one-shot install+retry is
 * worth attempting before withholding the merge.
 */
export { summarizeVerifyFailure };

// cmd.exe's "command not found" is LOCALIZED (#1092). A German box prints
// `Der Befehl "depcruise" ist entweder falsch geschrieben oder\nkonnte nicht gefunden werden.` —
// split across two lines — and matching only the English wording meant #169's install retry
// never fired there: the gate went straight to `verify_infra_missing` and a 2h backoff.
const MISSING_DEPS_SIGNATURE =
  /cannot find module|could not resolve|err_module_not_found|module_not_found|unresolved_import|enoent.*node_modules|command not found|is not recognized as an internal or external command|ist entweder falsch geschrieben oder\s+konnte nicht gefunden werden/i;

export function looksLikeMissingDepsFailure(output: string): boolean {
  return MISSING_DEPS_SIGNATURE.test(output);
}

/**
 * Open a `flaky`-tagged red-debt ledger entry for every suite #894's targeted re-run just
 * cleared (#915). Recording it here means the NEXT gate can consult the ledger's subset rule
 * instead of paying for another 45-minute full re-run to rediscover the same load-induced
 * flake. Best-effort by construction: an unrecordable entry must never turn a passing gate red.
 *
 * The subset rule (#915) compares ledger suite names against `failedSuitesForOutcome`'s output
 * (`failed-suite-parse.ts`), which never carries a package prefix — it normalizes to a bare
 * forward-slash path. `FailedSuite.file` here is ALREADY in that shape (`verify-flake-retry.ts`
 * strips ANSI and backslashes the same way); `packageLabel` exists only to disambiguate
 * same-named files across packages during the retry itself and must NOT be prepended here, or a
 * suite this ledgers as `flaky` would never string-match the base-health probe's un-prefixed
 * name on the next gate run — silently defeating the exact quarantine this exists to provide.
 */
async function recordFlakySuitesAsRedDebt(args: {
  flakySuites: FailedSuite[] | undefined;
  projectId: string;
  workingDir: string | null;
  database: Database;
}): Promise<void> {
  const { flakySuites, projectId, workingDir, database } = args;
  if (!flakySuites || flakySuites.length === 0) return;
  const sinceCommit = workingDir
    ? ((await revParse(workingDir, "HEAD").catch(() => null)) ?? "unknown")
    : "unknown";
  for (const suite of flakySuites) {
    const suiteName = suite.file;
    await openRedDebtEntry({ projectId, suite: suiteName, sinceCommit, tag: "flaky" }, database).catch((err) => {
      console.warn(`[pre-merge-gate] failed to open flaky red-debt entry for ${suiteName} (non-fatal):`, errorMessage(err));
    });
  }
}

export type { PreMergeGateWorkspace, PreMergeGateResult } from "./pre-merge-gate.types.js";

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

/**
 * The first PRE-FLIGHT block across a workspace TRAIN — an outstanding/failed install (#628) or a
 * FAILED setup script (#1123) — or null when every member clears both. One combined walk over
 * `memberWorkspaceIds` rather than two, so `runPreMergeGate` keeps a single `if` for both checks
 * (the #726 branch ceiling: each additional `if` in that function is its own branch, and the
 * ceiling is shrink-only — see `scripts/check-god-modules.mjs`).
 *
 * Extracted from `runPreMergeGate` for the same reason the #628 check originally was: a train
 * gates with a SYNTHETIC id (`train:<label>`) that matches no real workspace, so every real
 * member must be asked by name — see `memberWorkspaceIds`'s doc comment.
 */
async function describeBlockingPreflightForGate(
  workspace: PreMergeGateWorkspace,
  database: Database,
): Promise<string | null> {
  for (const checkId of workspace.memberWorkspaceIds ?? [workspace.id]) {
    const installBlock = await describeOutstandingRepoInstalls(checkId, database);
    if (installBlock) return installBlock;
    const setupFailure = await describeFailedSetupRun(checkId, database);
    if (setupFailure) return setupFailure;
  }
  return null;
}

export async function runPreMergeGate(
  workspace: PreMergeGateWorkspace,
  projectId: string,
  database: Database,
  /** #1203 — a train's own abort token; optional, combined below with #1164's per-workspace one. */
  signal?: AbortSignal,
): Promise<PreMergeGateResult> {
  // #1164 (per-workspace) + #1203 (a train's `signal`) — see `combineGateAbortSignals`'s doc comment.
  const combinedSignal = combineGateAbortSignals(beginMergeGateRun(workspace.id), signal);
  // ---- #628 deferred dependency installs ---------------------------------------------------
  // With install mode `background` the agent launches before its repos' dependencies exist, so
  // the protection `setupFailedBlocking` (#169) gave by refusing the LAUNCH has to be here
  // instead: a branch whose installs are still outstanding was never built against its real
  // dependencies, and one whose install FAILED never can be. Runs first and cheaply — a single
  // indexed read of this workspace's repo rows — and is a complete no-op for every project on
  // the inline install modes, where the column is NULL.
  // `memberWorkspaceIds` (the train) rather than `workspace.id`, because a synthetic gate id
  // matches no repo row and would pass this check vacuously — see the field's doc comment.
  //
  // ---- #1123 non-blocking setup failure, same walk -------------------------------------------
  // `setupFailedBlocking` (#169) refuses the LAUNCH, but only when `setup_blocking = 1`. With
  // background installs a failed setup never blocked the launch and never gets retried by the
  // born-blocked reconciler either (that recovery also requires `setup_blocking = 1`), so a
  // FAILED verdict here is otherwise permanent and invisible to every other guard — folded into
  // the same pre-flight walk rather than a second `if`, per the branch-ceiling note above.
  const preflightBlock = await describeBlockingPreflightForGate(workspace, database);
  if (preflightBlock) {
    return { passed: false, skipped: false, stage: "none", message: preflightBlock };
  }

  // What verification is CURRENTLY configured — resolved BEFORE the tree memo, and in
  // `pre-merge-gate-tier.ts` because that module owns the tier. See `resolveGateVerification`
  // for why the ordering is load-bearing.
  // #958: `workingDir` lets the key carry the test-impact SELECTOR's identity — the one thing
  // that changes what this gate runs while tier, verify command and merged tree stay identical,
  // because the skill is materialized into the worktree untracked. #966 folds the budget in there.
  const { strategy: gateStrategy, posture: gatePosture, effectiveVerify, verifyScript, verificationKey, budget: gateBudget } =
    await resolveGateVerification(projectId, database, { workingDir: workspace.workingDir });

  // ---- #492 tree-hash memo -----------------------------------------------------------------
  // A queue of ready branches re-ran the same suite against the same code: five branches, five
  // ~42-min gates. `git merge-tree --write-tree` gives the tree the merge WOULD produce, which
  // is an exact content fingerprint — if that tree already passed, the suite has nothing new to
  // tell us. Cheap (one git call, no checkout) and exact (a tree id is content, not a commit).
  //
  // Runs AFTER the install block so a workspace with outstanding installs is still refused: that
  // check is about THIS workspace's dependencies, not about the code, so a green tree elsewhere
  // says nothing about it.
  // #677: a multi-repo workspace lands sibling-repo code alongside the leading repo
  // (`executeSiblingMerges`), but everything below this point saw the LEADING repo only. Read the
  // sibling set once, here, and thread it into both the memo key and `changedFiles` — neither may
  // be blind to code that is actually about to merge.
  const siblingRepos = (await getAllWorkspaceRepos(workspace.id, database).catch(() => [])).filter(
    (repo) => repo.kind === "sibling",
  );

  // #677: folded over every sibling repo — a memo keyed on the leading tree alone would let a
  // branch with an identical leading diff but a DIFFERENT sibling diff reuse a PASS that never
  // saw that sibling code. A sibling this cannot fingerprint makes the whole hash null
  // (do-not-memoize), which is exactly the case the memo must not paper over.
  const treeHash = await combinedMergedTreeHash([
    { workingDir: workspace.workingDir, baseBranch: workspace.baseBranch },
    ...siblingRepos.map((repo) => ({ workingDir: repo.worktreePath, baseBranch: repo.baseBranch || workspace.baseBranch })),
  ]);
  if (wasTreeGatedGreen(projectId, treeHash, verificationKey)) {
    return {
      passed: true,
      skipped: false,
      stage: "verify",
      message: `pre-merge gate reused an earlier PASS for this exact merged tree (${treeHash!.slice(0, 12)}) — identical content, already verified (#492)`,
    };
  }

  // ---- #531 verify_script gate -------------------------------------------------------------
  // Resolution (and the #551/#377 reasoning behind it) is in `resolveGateVerification` above.
  if (effectiveVerify?.source === "derived") {
    console.log(`[pre-merge-gate] derived a verify_script for project ${projectId} at gate time — the repo has grown one since registration (#377): ${verifyScript}`);
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
  //
  // #677: folded over the sibling repos read above, so a LEADING diff that is docs-only can no
  // longer hide sibling SOURCE from `docsOnly` or from the tier's package scoping — both must see
  // every file this merge is about to land, not just the leading repo's half of it.
  const leadingChangedFiles = workspace.workingDir && workspace.baseBranch
    ? await getChangedFileNames(workspace.workingDir, workspace.baseBranch).catch(() => [] as string[])
    : ([] as string[]);
  const siblingChangedFiles = (
    await Promise.all(
      siblingRepos.map(async (repo) => {
        const repoBase = repo.baseBranch || workspace.baseBranch;
        if (!repo.worktreePath || !repoBase) return [] as string[];
        return getChangedFileNames(repo.worktreePath, repoBase).catch(() => [] as string[]);
      }),
    )
  ).flat();
  const changedFiles = [...leadingChangedFiles, ...siblingChangedFiles];
  const docsOnly = changedFiles.length > 0 && isDocsOnlyDiff(changedFiles);
  // #1008: a SUPERSET of `docsOnly` — documentation plus the modelled config/data paths
  // (`.gitignore`, `.code-metrics/**`, `.claude/settings*.json`, `.codex/**`, non-code
  // `docs/**`). Nothing under `packages/` can import those, so the package scoper returns null
  // for them, and null used to mean "run everything" — the #999 diff (four such files) ran the
  // whole server package twice and timed out both times. They are not UNKNOWN paths: the
  // `@gate:always-run` guards are exactly what checks them. Genuinely un-modelled paths still
  // return false here and keep the full run. `docsOnly` stays the narrower signal for the
  // smoke skip and the foreign-project wholesale skip (#198), which are about documentation.
  const guardsOnlyDiff = isGuardsOnlyDiff(changedFiles);

  // Populated once verify_script actually runs, so the final message can NAME what ran even on
  // a passing gate (#538) — a level may only weaken verification VISIBLY, so the tier that was
  // actually used must be sayable regardless of outcome.
  let gateTierInfo: GateTierInfo | null = null;

  // #675 follow-up: the guards-only docs-only run is THIS repo's mechanism, so ask first
  // whether this project IS this repo. `KANBAN_TEST_GUARDS_ONLY` is honoured only by
  // `scripts/test-mine.mjs`; every other registered project's verify_script (gradlew.bat,
  // pytest, mvn, …) ignores the variable entirely and would run its FULL suite instead — so
  // for them a markdown-only change would cost the ~40-minute build that #198's skip exists
  // to avoid. Measured shape of the bug: the env var made the narrowing look universal while
  // being inert everywhere but here. A foreign project keeps the wholesale #198 skip.
  // Hoisted out of the docs-only expression below because #894's flake retry needs the same
  // answer for a different reason: a suite scope is honoured only by THIS repo's
  // `scripts/test-mine.mjs`, so for any other project a "retry" would be a second FULL run.
  // Read once and kept: `isSelfProjectRepo` needs it here, the smoke block needs it below, and
  // #954's outcome ledger needs it as the MAIN checkout that owns `.test-impact/outcomes.jsonl`
  // (a ledger written into the worktree would be deleted with the worktree and never accumulate).
  const projectRepoPath = await getProjectRepoPath(projectId, database);
  const isSelfRepo = isSelfProjectRepo(projectRepoPath);
  // #1008: `guardsOnlyDiff`, not `docsOnly` — the config/data paths above get the same
  // guards-only run on THIS repo. For any other project they fall through to the full run
  // (a foreign verify_script ignores the env var, and only documentation earns #198's skip).
  const docsOnlyGuardsRunApplies = guardsOnlyDiff && isSelfRepo;
  /**
   * Set when #894's targeted re-run cleared a load-induced failure, so the PASSING gate
   * message can say the suites were re-run. A gate that quietly downgrades its own evidence
   * is the thing `CLAUDE.md` forbids — a level may only weaken verification visibly.
   */
  const skipVerifyForForeignDocsOnly = docsOnly && !docsOnlyGuardsRunApplies;
  if (skipVerifyForForeignDocsOnly && verifyConfigured && workspace.workingDir) {
    console.log(`[pre-merge-gate] skipping verify_script for workspace ${workspace.id} — diff touches only docs (${changedFiles.length} file(s)), and this project's verify_script has no guards-only mode (#198)`);
  }
  if (verifyConfigured && workspace.workingDir && !skipVerifyForForeignDocsOnly) {
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
      gateDir = { path: tmpdir(), dispose: () => true, disposeAsync: async () => true };
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
    const isolationEnv = {
      ...gradleEnv,
      AGENTIC_KANBAN_DIR: gateDataDir,
      // A board with a fleet configured holds its git/fleet sockets while the gate runs;
      // inheriting those pins makes any suite that opens a listener die with EADDRINUSE and
      // blames the branch for it. See lib/verify-env.ts.
      ...VERIFY_NEUTRALIZED_LISTENER_ENV,
      // ...and the same door one precedence level up: the board launches sessions with
      // `KANBAN_DB_URL` set, and that OUTRANKS the `AGENTIC_KANBAN_DIR` two lines above — so
      // without this the #231 isolation the comment block above describes was inert and the
      // gate's vitest workers opened the live board DB. MUST stay after AGENTIC_KANBAN_DIR.
      ...VERIFY_NEUTRALIZED_DB_LOCATION_ENV,
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

    // #643: `full` is documented as "no scoping; every package's full suite runs". It only ever
    // disabled FILE-level scoping — `KANBAN_TEST_PACKAGES` was set regardless — so on the
    // DEFAULT setting a diff still skipped whole packages while the knob claimed otherwise. The
    // tier message was honest ("package-scoped"); the operator-facing name was not. Since the
    // pref's whole purpose is that a level may only weaken verification VISIBLY, the code moves
    // to match the documentation rather than the reverse.
    const { packagesEnv: effectiveTestScope, fileScoped: fileScope } = resolveGateScoping({
      strategy: gateStrategy,
      testScope,
      fileScopePref: testScope ? await resolveVerifyFileScope(projectId, database) : false,
      changedFileCount: changedFiles.length,
    });
    // A docs-only diff runs the GUARD suites and nothing else, instead of skipping the verify
    // script wholesale as #198 did. The skip sat upstream of the `@gate:always-run` mechanism,
    // so the suites explicitly marked "must run even when the gate scopes" were not run at all
    // — and ~16 of them take markdown as their assertion INPUT (`CLAUDE.md`, `docs/env-vars.md`,
    // the `.claude`/`.codex` `SKILL.md` pairs). That is not hypothetical: a `SKILL.md`-only
    // branch merged green here and left master red on `codex-skills-parity`, the guard that
    // exists to catch exactly that drift. The premise "a `.md` change cannot break the build"
    // is false BY CONSTRUCTION in this repo, so the cheap-check motive is honoured by narrowing
    // to the guards rather than by checking nothing.
    //
    // #962/#967 — the selector, and whether the file scope is emitted ALONGSIDE it. See
    // `resolveGateFileScopeEmission` for why what #962 had to resolve as a conflict is now a union.
    const { selector: gateSelector, emitFileScope, unioned: gateUnioned, note: fileScopeNote } = resolveGateFileScopeEmission({
      env: process.env,
      fileScoped: fileScope,
      changedFileCount: changedFiles.length,
      strategy: gateStrategy,
      budget: gateBudget, // #966 — a THIRD route to the impact selector; see the resolver's doc
    });
    // #956 — the three scoping vocabularies do not compose freely, so their precedence lives in
    // one pure function beside the resolvers that feed it. See `buildVerifyEnv`.
    const verifyEnv = buildVerifyEnv({
      isolationEnv,
      guardsOnly: docsOnlyGuardsRunApplies,
      impactEnv: resolveImpactSelectorEnv({
        strategy: gateStrategy,
        baseBranch: workspace.baseBranch,
        changedFiles,
        fileExists: (file) => existsSync(join(workingDir, file)),
        budget: gateBudget,
      }),
      packagesEnv: effectiveTestScope,
      emitFileScope,
      changedFiles,
    });
    if (docsOnlyGuardsRunApplies) {
      console.log(`[pre-merge-gate] ${guardsOnlyReasonFor(docsOnly)} diff for workspace ${workspace.id} (${changedFiles.length} file(s)) — running @gate:always-run guard suites only (#1008)`);
    }
    // One branch, and the message itself was chosen by `resolveGateFileScopeEmission` — the
    // dropped-scope case is a different MESSAGE about the same decision, not a second decision.
    if (fileScopeNote) {
      console.log(`[pre-merge-gate] ${fileScopeNote} for workspace ${workspace.id}`);
    }
    gateTierInfo = {
      strategy: gateStrategy,
      // #962: which selector chose the suites, so an impact-narrowed run is recorded as
      // `impact-scoped` rather than as `full` — the latter asserts that every suite was observed,
      // which is the one claim such a run cannot make.
      selector: gateSelector,
      // #956: what the selection kept and dropped, for the PASS message — the same `select --json`
      // the #954 ledger makes, so message and ledger cannot disagree about what it was.
      // #1039 — `impactSelection`, plus `impactSelectorAbsent` when the reason it is null is that
      // the selector was never in the worktree. One spread, so the gate function (on the branch
      // ratchet) spends no branch on the distinction; the helper makes it.
      ...(await resolveGateImpactTierFields({
        applies: gateSelector === "impact" && !docsOnlyGuardsRunApplies,
        workingDir,
        baseBranch: workspace.baseBranch,
        budget: gateBudget?.value ?? null, // #966 — describe the selection the run MAKES
        // #967 — the run will union `vitest related`'s picks in, but this description cannot
        // reproduce that half (only the runner walks vitest's module graph). Saying so beats
        // reporting the impact half as if it were the whole selection.
        unioned: gateUnioned && !docsOnlyGuardsRunApplies,
      })),
      packageScoped: Boolean(effectiveTestScope) && !docsOnlyGuardsRunApplies,
      // What was actually EMITTED, not what the scoping decision wanted. Since #967 the file list
      // IS emitted under the impact selector — the runner unions it in rather than refusing the
      // pair — so this is `true` for a union run, and that is what `gateRanScope` reads to record
      // it as `impact+related`.
      fileScoped: emitFileScope && !docsOnlyGuardsRunApplies,
      // #1008: WHICH narrow diff earned the guards-only run — the message must say
      // "docs+config-only", since "docs-only" would misdescribe a `.gitignore`/settings change.
      ...(docsOnlyGuardsRunApplies ? { guardsOnly: true, guardsOnlyReason: guardsOnlyReasonFor(docsOnly) } : {}),
      changedFileCount: changedFiles.length,
      // #1043 — the guard floor's SIZE AND COST, and both describe THIS run: the `when:`
      // preconditions (#1041) are applied against exactly the change set the runner sees,
      // including guards-only docs runs, and only the packages the runner admits.
      ...guardFloorFor(workingDir, changedFiles, {
        narrowed: emitFileScope || docsOnlyGuardsRunApplies,
        packages: effectiveTestScope?.split(","),
        guardsOnly: docsOnlyGuardsRunApplies,
      }),
      // Filled with the sampled capacity only once execution is admitted.
      maxWorkers: DEFAULT_VERIFY_MAX_WORKERS,
      // #581: say whether this run was protected from builder contention. A gate that
      // failed with builders competing for the box is a different claim from one that
      // failed on a quiet machine, and the failure text alone never distinguishes them.
      buildersQuiesced: await quiesceBuildersEnabled(projectId, database).catch(() => undefined),
      // #937 / decision 017: when the TIER came from the risk-posture dial rather than an
      // explicit `verify_gate_strategy_<projectId>` override, the message must say so and name
      // what that posture skips — a weaker posture may only weaken verification VISIBLY.
      // Already `undefined` in the override case (`resolveGateVerification` decides that), so
      // this is an unconditional carry, not another branch in this already-branchy function.
      posture: gatePosture,
    };
    // #977 — the phase transitions, reported from the seams that already exist. `queued` is
    // the one that mattered: a gate waiting behind another workspace's verify chain rendered
    // as `Verifying · 40m`, indistinguishable from a suite that had been executing that long.
    // Noted inside `runVerify` rather than beside the semaphore acquisition so the post-install
    // re-run walks back from `install` to `verify` for free.
    //
    // #988 — the LAST full verify run's step self-reports and wall clock. `resolveVerifyOutcome`
    // collapses the runs into a verdict and keeps no stdout on the passing path, so the timings
    // are captured here, at the one seam that sees every run. Last-run-wins on purpose: when an
    // install retry re-ran the whole script, the run that produced the verdict is the one whose
    // cost the message should name, and reporting the first (failed, partial) run's steps beside
    // a PASSED verdict would describe a run that is not the one that passed.
    //
    // Only the full `runVerify` writes here — the flake retry deliberately does not, since it
    // runs a narrowed subset and its step line would understate what the gate actually cost.
    let lastVerifySteps: VerifyStepTiming[] = [];
    let lastVerifyRunMs: number | undefined;
    const runVerify = async () => {
      noteMergeGatePhase(workspace.id, "verify");
      // Started INSIDE the semaphore callback, not before it. `runUnderBuildSemaphore` can hold
      // this task for minutes behind another workspace's build, and timing from out here would
      // book that queue wait into `verifyRunMs` — which the message then prints as
      // `+ Ns unaccounted`, i.e. as time the SCRIPT spent between its steps. That is precisely
      // the conflation the clause exists to prevent, and it is already reported separately and
      // honestly as `queued Ns behind another verification` (#949).
      let startedAt = Date.now();
      const result = await runUnderBuildSemaphore(async () => {
        // Capacity observed before a long queue says nothing about the host at admission.
        const workers = await resolveVerifyMaxWorkers(projectId, database);
        Object.assign(verifyEnv, buildVerifyResourceEnv(workers.workers));
        Object.assign(gateTierInfo!, {
          maxWorkers: workers.workers,
          maxWorkersDerived: workers.derived,
          hostFreeGb: workers.hostFreeGb,
          // #1160 — the slot partition the worker share came from, and the company this chain
          // ran in. Read INSIDE the chain slot, so `chainsInFlight` counts this gate itself.
          chainSlots: workers.chainSlots,
          chainsInFlight: workers.chainsInFlight,
        });
        startedAt = Date.now();
        return runSetupScript(workingDir, verifyScript!, { timeoutMs: verifyTimeoutMs, env: verifyEnv, signal: combinedSignal })
          .catch((e) => ({ exitCode: 1, stdout: "", stderr: String(e), timedOut: false }));
      });
      lastVerifyRunMs = Date.now() - startedAt;
      // Total by construction (see `verify-step-timings.ts`): an unparseable or step-less run
      // yields `[]` and the message simply omits the clause. It must never be able to turn a
      // green gate into an error, which is why nothing here can throw.
      lastVerifySteps = parseVerifyStepTimings(result.stdout);
      return result;
    };
    // #169's install retry and #894's targeted flake retry both answer ONE question - "is this
    // failure the code's fault?" - and inlined here they took runPreMergeGate past the
    // god-module gate's branch ceiling. They live in verify-retry-strategies.ts now; everything
    // that needs a worktree, the database or the build semaphore is injected below.
    //
    // #903 — the WHOLE chain (first run + any install/flake retry) runs under the
    // cross-workspace verify-chain semaphore, not just each individual invocation. Two
    // different workspaces' chains used to freely interleave inside `runUnderBuildSemaphore`'s
    // own cap (default 2), which is what let three full-suite runs contend on one box at once.
    // #1009 — BEFORE taking the chain slot: join a base-health run already in flight, or run a
    // due one to completion first, or say the host is too tight to measure the base at all.
    // Never two suites at once on this box, and the message names whichever happened. Total
    // by construction (`note` is null when nothing was due), so no branch here — this function
    // sits on the god-module gate's branch ceiling.
    // #1057 — BEFORE anything expensive: may this box run a verify chain at all? The base-health
    // probe has asked this since #1009; the gate, running the same script, never did. A saturated
    // host produces a ~28-minute run that fails in an arbitrary batch and proves nothing (measured
    // three times over on 2026-09-07), so decline cheaply and let the next cycle retry. `held` is
    // NOT a red gate — see PreMergeGateResult.held — and #638 keeps a withheld gate away from the
    // fix agent. Fail-open: an unreadable capacity admits, exactly as #1009 does.
    const admission = await resolveGateHostAdmission({ projectId, database }).catch(
      () => ({ admit: true, reason: "host_has_room" }) as Awaited<ReturnType<typeof resolveGateHostAdmission>>,
    );
    if (!admission.admit) {
      // The wording lives in `describeGateHold` (a pure lookup, see its header): picking it with
      // a `? :` HERE added a 35th branch to this function and turned the master sweep red, which
      // is what the "no branch here" note above is about.
      const hold = describeGateHold(admission, projectId);
      noteMergeGatePhase(workspace.id, "held", hold.phaseNote);
      return { passed: false, skipped: false, held: true, stage: "verify", message: hold.message };
    }
    gateTierInfo.baseHealthNote = (await sequenceBaseHealthBeforeVerify({ projectId, database, workspaceId: workspace.id })).note ?? undefined;
    noteMergeGatePhase(workspace.id, "queued", "waiting for the cross-workspace verify chain");
    const { result: outcome, queueWaitMs, lockNote } = await runUnderVerifyChainSemaphoreTimed(async () =>
      resolveVerifyOutcome({
        result: await runVerify(),
        runVerify,
        runVerifyWithRetryScope: (retryScope) => {
          noteMergeGatePhase(workspace.id, "flake-retry", "re-running only the failing tests");
          return runUnderBuildSemaphore(() =>
            runSetupScript(workingDir, verifyScript!, {
              timeoutMs: verifyTimeoutMs,
              env: { ...verifyEnv, KANBAN_RETRY_TEST_FILES: retryScope },
              signal: combinedSignal,
            }).catch((e) => ({ exitCode: 1, stdout: "", stderr: String(e), timedOut: false })),
          );
        },
        getInstallCommand: () => getProjectSetupScript(projectId, database).catch(() => null),
        runInstall: async (command) => {
          noteMergeGatePhase(workspace.id, "install", command);
          await runUnderBuildSemaphore(() =>
            runSetupScript(workingDir, command, {
              timeoutMs: DEFAULT_SETUP_SCRIPT_TIMEOUT_MS,
              env: gradleEnv,
              signal: combinedSignal,
            }).catch((e) => ({ exitCode: 1, stdout: "", stderr: String(e), timedOut: false })),
          );
        },
        looksLikeMissingDeps: looksLikeMissingDepsFailure,
        // Only this repo's `scripts/test-mine.mjs` honours a suite scope; for any other project
        // the env var is inert and the "targeted re-run" would be a second FULL run.
        scoped: isSelfRepo,
        verifyTimeoutMs,
        projectId,
        workspaceId: workspace.id,
        summarize: (stdout, stderr) => summarizeVerifyFailure(stdout, stderr, workspace.id),
      }),
      `verify chain for workspace ${workspace.id}`,
    );
    // #949: how long this gate spent QUEUED behind another heavyweight verification. Carried
    // onto the tier info so a PASSING gate can say so — the same "the conditions a verdict was
    // produced under are part of the verdict" rule as `buildersQuiesced`.
    //
    // Non-null assertion rather than an `if`: `gateTierInfo` is assigned unconditionally a few
    // lines above and nothing clears it in between, so a guard here would be dead — and this
    // function sits ON the god-module gate's 25-branch ceiling (grandfathered at 37), where a
    // branch that can never be false still counts against the budget.
    gateTierInfo!.queueWaitMs = queueWaitMs;
    // #957: non-null only when the chain ran WITHOUT the cross-process machine lock — it waited
    // out its role's bound behind a holder it could not outlast, or the lock could not be hosted
    // here. Assigned unconditionally (`?? undefined` rather than an `if`) for the same reason the
    // line above uses a non-null assertion instead of a guard: this function is ON the
    // god-module gate's 25-branch ceiling, grandfathered at 37 and shrink-only, so a branch here
    // would have to be paid for by restructuring something else. The tier formatter already
    // treats undefined as "say nothing".
    gateTierInfo!.unserializedNote = lockNote ?? undefined;
    // #988: where the run's time went, per the steps' own reports. Assigned unconditionally
    // (an empty array means "the script said nothing", which the formatter renders as silence)
    // for the same reason the two lines above avoid a guard: this function sits ON the
    // god-module gate's branch ceiling, so a branch that only ever guards an empty array
    // would have to be paid for by restructuring something else.
    gateTierInfo!.stepTimings = lastVerifySteps;
    gateTierInfo!.verifyRunMs = lastVerifyRunMs;
    // #954 — the ledger row for THIS run. Recorded before the failure return so a red gate is
    // observed too: a failing run is the only kind that can contain a miss at all, so recording
    // only green runs would measure the heuristic exclusively on the cases where it cannot be
    // wrong. Awaited (not fire-and-forget) so a merge never races the write, and `recordVerifyGateOutcome`
    // is total — it resolves to `{recorded:false, reason}` rather than throwing, so this cannot
    // turn a verdict into an error.
    //
    // #963 — `baseBranch` is not optional decoration: without it the selection is computed from
    // an EMPTY change set (a gate runs on a clean, fully-committed tree, so `git diff HEAD` and
    // the untracked list are both empty) and every row records the constant always-run set with a
    // free `missed: 0`.
    const ledger = await recordVerifyGateOutcome({
      workspaceId: workspace.id,
      workingDir,
      repoPath: projectRepoPath,
      baseBranch: workspace.baseBranch,
      outcome,
      tierInfo: gateTierInfo,
    });
    if (outcome.failure) {
      // #1230 — the failing suites ride on the result and lead its message; total, so no branch here.
      return withFailedSuites({ passed: false, skipped: false, stage: "verify" as const, ...outcome.failure }, ledger);
    }
    // Carried on the tier info so the PASSING message names it (see GateTierInfo).
    if (gateTierInfo && outcome.flakeRetryNote) gateTierInfo.flakeRetryNote = outcome.flakeRetryNote;
    // #915 — a suite #894 just cleared with a targeted re-run is exactly what the red-debt
    // ledger's `flaky` tag exists for. Extracted (rather than inlined) so this branchy-by-nature
    // best-effort loop does not count against `runPreMergeGate`'s own god-module branch budget.
    await recordFlakySuitesAsRedDebt({ flakySuites: outcome.flakySuites, projectId, workingDir, database });
    } finally {
      // #1164 — spent either way; drop it so a later cancel can't mistake this for a live gate.
      endMergeGateRun(workspace.id);
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
  // #644: set when the smoke block errored out rather than reaching a verdict. The whole block
  // used to sit inside ONE catch that logged a warning and fell through to `passed: true`, and
  // the final message then reported the verify tier as if nothing had been skipped — so an
  // infrastructure failure in the boot check was indistinguishable from a clean pass. Still
  // non-fatal (a harness error must not withhold an otherwise-green merge), but no longer
  // silent: the gate says "smoke inconclusive" and names why.
  let smokeInconclusive: string | null = null;
  try {
    const profile = await getStackProfile(projectId, database);
    // #657: resolve the same dev-server plan the Diagnostics tab and the dev-server skill
    // use, so an operator's `health_url_<projectId>` / `dev_command_<projectId>` reaches the
    // merge gate too. It also supplies the port for a project whose dev ports are computed at
    // RUNTIME — this repo's own 3001+N/5173+N worktree math, which no static package.json read
    // can know, and which left `devPort: null` and the smoke gate permanently inert.
    const plan = await resolveProjectDevServerPlan(projectId, database, {
      profile,
      workingDir: workspace.workingDir,
      isSelfProject: isSelfRepo,
    }).catch((err: unknown) => {
      // Non-fatal on purpose: a failed plan read degrades to the profile-only smoke check
      // that existed before, rather than turning the whole gate inconclusive.
      console.warn(`[pre-merge-gate] dev-server plan unavailable for project ${projectId}:`, errorMessage(err));
      return null;
    });
    const smokeCheck = buildSmokeCheck(profile, plan);
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
        noteMergeGatePhase(workspace.id, "smoke", "boot + render check");
        // #1095: the smoke boot starts a SECOND full board process next to the live one, and
        // without isolation it inherits the live board's KANBAN_DB_URL/listener pins (or, absent
        // those, still resolves the operated `~/.agentic-kanban/kanban.db` home-fallback) — so it
        // reattached a live agent session and ran its own monitor cycle (auto-merge selection,
        // auto-start) against the OPERATED database. Same isolation the verify half already gets
        // (#231, see createSmokeIsolation below): a throwaway AGENTIC_KANBAN_DIR plus the
        // neutralized DB-location/listener env, and — since even a throwaway DB should not run a
        // monitor loop — background services skipped outright for this boot.
        const smokeIsolation = createSmokeIsolation();
        try {
          // #949: the chain semaphore, not just the build semaphore. This boots a real dev server
          // and polls a health URL; under the build semaphore alone (derived width up to 8) it ran
          // freely alongside ANOTHER gate's verify chain, which is the contention #903 set out to
          // remove and only removed for the verify half.
          const smoke = await runUnderVerifyChainSemaphore(
            () => runUnderBuildSemaphore(() => runSmokeCheck(workspace.workingDir!, smokeCheck, { env: smokeIsolation.env })),
            `smoke check for workspace ${workspace.id}`,
          );
          if (!smoke.passed) {
            return { passed: false, skipped: false, stage: "smoke", message: `smoke check failed: ${smoke.message}` };
          }
        } finally {
          smokeIsolation.disposeAndWarn(`workspace ${workspace.id}`);
        }
      }
    }
  } catch (smokeErr) {
    // NON-FATAL: a harness error (not a failed boot) must not block an otherwise-passing merge.
    // But it must not be invisible either (#644) — record it so the gate message says so.
    smokeInconclusive = errorMessage(smokeErr);
    console.warn(`[pre-merge-gate] smoke check errored (non-fatal) for workspace ${workspace.id}:`, smokeInconclusive);
  }

  // #660 — the E2E smoke lane, opt-in per project. Lives in `e2e-smoke-lane.ts` with the
  // runner and the decision it acts on; this file only consumes the verdict.
  const e2eSmoke = await runE2ESmokeGateStage({
    projectId,
    workingDir: workspace.workingDir,
    workspaceId: workspace.id,
    docsOnly,
    database,
  });
  const e2eSmokeRan = e2eSmoke.ran;
  const e2eSmokeInconclusive = e2eSmoke.inconclusive;
  if (e2eSmoke.failure) {
    return { passed: false, skipped: false, stage: "verify", message: e2eSmoke.failure };
  }

  // `verifyRan` — not `verifyConfigured` — because the verify script only runs when there is a
  // worktree to run it in. Reporting stage "verify" for a run that never happened would write
  // false evidence into `mergeGateStage`, which is exactly the dishonesty #182 set out to
  // remove. On THIS repo a docs-only diff does run it (narrowed to the `@gate:always-run` guard
  // suites, see the tier note above), and `buildGateTierMessage` names the guards-only tier so
  // the narrower claim stays visible instead of passing as a full run; on any OTHER project a
  // docs-only diff still skips verify_script wholesale, and saying "verify ran" there would be
  // the same false evidence in a new place.
  const verifyRan = verifyConfigured && Boolean(workspace.workingDir) && !skipVerifyForForeignDocsOnly;
  const ranSomething = verifyRan || smokeApplies || e2eSmokeRan;
  // #377 — "nothing is configured" is NOT the same state as "the configured gate was skipped for a
  // docs-only diff", and conflating them is how eight unverified merges went unremarked. A project
  // with no gate at all is `unverified`; a project with a gate that deliberately skipped is not.
  const unverified = !ranSomething && !verifyConfigured;
  // #492 — remember only a run that actually CHECKED something. A skipped or unverified gate
  // proves nothing about the tree, and memoizing it would let "nothing ran" propagate to every
  // later branch that happens to produce the same content.
  if (ranSomething && !smokeInconclusive && !e2eSmokeInconclusive) rememberTreeGatedGreen(projectId, treeHash, verificationKey);
  return {
    passed: true,
    skipped: !ranSomething,
    stage: ranSomething ? (verifyRan ? "verify" : "smoke") : "none",
    message: ranSomething
      ? `${buildGateTierMessage(gateTierInfo)}${e2eSmokeRan ? ", +E2E smoke lane" : ""}${smokeInconclusive ? ` — WARNING: smoke check inconclusive (${smokeInconclusive})` : ""}${e2eSmokeInconclusive ? ` — WARNING: E2E smoke lane inconclusive (${e2eSmokeInconclusive})` : ""}`
      : smokeInconclusive
        ? `pre-merge gate ran nothing — smoke check inconclusive (${smokeInconclusive})`
        : docsOnly
          ? `pre-merge gate skipped — docs-only diff (${changedFiles.length} file(s))`
          : "NOT VERIFIED: this project has no verify_script and no smoke check, so nothing checked this merge (#377)",
    ...(unverified ? { unverified: true } : {}),
    ...impactSelectionField(ranSomething, gateTierInfo),
  };
}

/**
 * #1030 — the `impactSelection` field of a gate result, present only for a run that actually
 * verified something: a skipped gate made no selection. Its own function so the branch it adds
 * counts here and not against `runPreMergeGate` (god-module gate, baseline 34).
 */
function impactSelectionField(
  ranSomething: boolean,
  gateTierInfo: GateTierInfo | null,
): Pick<PreMergeGateResult, "impactSelection"> {
  return ranSomething && gateTierInfo && gateTierInfo.impactSelection !== undefined
    ? { impactSelection: gateTierInfo.impactSelection }
    : {};
}

// The merge-gate DECISION token (#943) lives in ./merge-gate-token.ts — re-exported here
// so every existing importer of this module keeps working (facade barrel, god-module gate).
import {
  evidenceIsValid,
  resolveMergeGateShas,
  type MergeGateShas,
  type MergeGateToken,
  type ResolvedMergeGate,
} from "./merge-gate-token.js";

export {
  MERGE_GATE_EVIDENCE_MAX_AGE_MS,
  RUN_GATE,
  gateAlreadyPassed,
  gateSkipExplicit,
  resolveMergeGateShas,
} from "./merge-gate-token.js";
export type { MergeGateEvidence, MergeGateShas, MergeGateToken, ResolvedMergeGate } from "./merge-gate-token.js";

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
    // #1057 — a HELD gate must stay distinguishable from a red one all the way out to the
    // caller: it did not run, so "the gate failed" would be a false claim about the diff.
    ...(gate.held ? { held: true } : {}),
    ...(gate.impactSelection !== undefined ? { impactSelection: gate.impactSelection } : {}),
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
    // #936/#1220 — the discard reason names WHAT MOVED (branch/base/neither), built in its
    // own module (see merge-gate-verdict-reason.ts for why the message matters).
    const reason = buildStaleVerdictReason(token.evidence, currentShas);
    console.warn(
      `[merge-gate] workspace ${workspace.id}: DISCARDING an already-passed verdict from `
        + `${token.evidence.source} (stage ${token.evidence.stage}, ran ${token.evidence.ranAt}) — `
        + `${reason} — so the gate is being re-run in full (#936).`,
    );
    const result = await runGateAsResolved(workspace, projectId, database);
    return { ...result, decision: "run-gate-stale-evidence" };
  }

  const result = await runGateAsResolved(workspace, projectId, database);
  return { ...result, decision: "run-gate" };
}

/**
 * Does a project have an automatic pre-merge gate, and what does it consist of (#546)?
 *
 * "Has a gate" was derived THREE ways and all three disagreed with the gate itself:
 *   - `projectHasMergeGate` (monitor-cycle): `verify_script` OR `profile.isWeb`,
 *   - the merge-queue orchestrator: a regex sweep over prefMap, also `verify_script` OR `isWeb`,
 *   - the real gate: `verify_script` OR `buildSmokeCheck(...) !== null`, which additionally
 *     needs a dev command AND a resolvable health URL.
 *
 * The consequence of the over-approximation is not cosmetic: for an `isWeb` project with no
 * dev command, both callers classified it as GATED and therefore suppressed
 * `auto_merge_in_review` — waiting for a gate verdict that `buildSmokeCheck` returns `null`
 * for, i.e. one that never runs.
 *
 * So the question is answered ONCE, by asking the same builders the gate asks. `plan` is the
 * pure dev-server plan, so the answer accounts for the `dev_command`/`health_url` overrides
 * that can create a smoke gate a profile alone would not have.
 */
export interface MergeGateConfig {
  /** The configured verify command, or null when the project has none. */
  verifyScript: string | null;
  /** The smoke check that would run, or null when this project has none. */
  smoke: SmokeCheck | null;
  /** True when at least one half of the gate applies. */
  hasGate: boolean;
}

export function resolveMergeGateConfig(input: {
  verifyScript: string | null | undefined;
  profile: StackProfile | null;
  devCommandOverride?: string | null;
  healthUrlOverride?: string | null;
}): MergeGateConfig {
  const verifyScript = input.verifyScript?.trim() ? input.verifyScript : null;
  const plan = resolveDevServerPlan({
    profile: input.profile,
    devCommandOverride: input.devCommandOverride,
    healthUrlOverride: input.healthUrlOverride,
    // No workingDir here: the worktree-port convention is a property of a specific
    // checkout, and this question is about the PROJECT.
    isSelfProject: false,
  });
  const smoke = buildSmokeCheck(input.profile, plan);
  return { verifyScript, smoke, hasGate: Boolean(verifyScript) || smoke !== null };
}
