import { gateVerificationKey, combinedMergedTreeHash, rememberTreeGatedGreen, wasTreeGatedGreen } from "./merge-gate-tree-memo.js";
import { getAllWorkspaceRepos } from "./workspace-all-repos.js";
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
import { describeOutstandingRepoInstalls } from "./pre-merge-gate-installs.js";
import { getProjectSetupScript } from "../repositories/stack-profile.repository.js";
import { buildSmokeCheck, getStackProfile, resolveEffectiveVerify } from "./stack-profile.service.js";
import { resolveDevServerPlan } from "./dev-server.service.js";
import type { SmokeCheck, StackProfile } from "@agentic-kanban/shared";
import { resolveProjectDevServerPlan } from "./dev-server.service.js";
import { quiesceBuildersEnabled } from "./gate-quiesce.js";
import { isSelfProjectRepo } from "./self-project.js";
import { getProjectRepoPath } from "../repositories/project.repository.js";
import { runUnderBuildSemaphore } from "./jvm-build-semaphore.js";
import { runUnderVerifyChainSemaphore } from "./verify-chain-semaphore.js";
import { runE2ESmokeGateStage } from "./e2e-smoke-lane.js";
import {
  resolveGateVerification,
  resolveVerifyGateStrategy,
  countAlwaysRunGuardSuites,
  buildGateTierMessage,
  resolveGateScoping,
  type GateTierInfo,
} from "./pre-merge-gate-tier.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { VERIFY_SCRIPT_TIMEOUT_MS } from "./verify-budget.js";
// #221/#490's failure-message shaping lives in its own module now (this file crossed the
// 1000-line god-module ceiling). Re-exported below so its importers are unchanged.
import { summarizeVerifyFailure } from "./verify-failure-summary.js";
import { VERIFY_NEUTRALIZED_LISTENER_ENV } from "../lib/verify-env.js";
import { resolveVerifyOutcome } from "./verify-retry-strategies.js";
import type { FailedSuite } from "./verify-flake-retry.js";
import { openRedDebtEntry } from "../repositories/red-debt.repository.js";

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

const MISSING_DEPS_SIGNATURE =
  /cannot find module|could not resolve|err_module_not_found|module_not_found|unresolved_import|enoent.*node_modules|command not found|is not recognized as an internal or external command/i;

function looksLikeMissingDepsFailure(output: string): boolean {
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
  /**
   * The workspaces whose deferred dependency installs this gate must clear, when that is not
   * simply `[id]`.
   *
   * The merge train gates the TREE that lands, so it calls this gate with a SYNTHETIC id
   * (`train:<label>`) that matches no `repos` row — which silently turned the #628 install
   * check into a no-op for every member of the train: `rows = []` → nothing blocking → land.
   * Two workspaces each individually withheld for a running install could therefore both land
   * via the train, which is exactly the "merged code built against missing deps" this check
   * exists to prevent. A caller gating something other than one real workspace must name the
   * real workspaces here.
   */
  memberWorkspaceIds?: string[];
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
  // ---- #628 deferred dependency installs ---------------------------------------------------
  // With install mode `background` the agent launches before its repos' dependencies exist, so
  // the protection `setupFailedBlocking` (#169) gave by refusing the LAUNCH has to be here
  // instead: a branch whose installs are still outstanding was never built against its real
  // dependencies, and one whose install FAILED never can be. Runs first and cheaply — a single
  // indexed read of this workspace's repo rows — and is a complete no-op for every project on
  // the inline install modes, where the column is NULL.
  // `memberWorkspaceIds` (the train) rather than `workspace.id`, because a synthetic gate id
  // matches no repo row and would pass this check vacuously — see the field's doc comment.
  for (const installCheckId of workspace.memberWorkspaceIds ?? [workspace.id]) {
    const installBlock = await describeOutstandingRepoInstalls(installCheckId, database);
    if (installBlock) {
      return { passed: false, skipped: false, stage: "none", message: installBlock };
    }
  }

  // What verification is CURRENTLY configured — resolved BEFORE the tree memo, and in
  // `pre-merge-gate-tier.ts` because that module owns the tier. See `resolveGateVerification`
  // for why the ordering is load-bearing.
  const { strategy: gateStrategy, posture: gatePosture, effectiveVerify, verifyScript, verificationKey } =
    await resolveGateVerification(projectId, database);

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
  const isSelfRepo = isSelfProjectRepo(await getProjectRepoPath(projectId, database));
  const docsOnlyGuardsRunApplies = docsOnly && isSelfRepo;
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
    const resolvedWorkers = await resolveVerifyMaxWorkers(projectId, database);
    const gateMaxWorkers = resolvedWorkers.workers;
    const isolationEnv = {
      ...gradleEnv,
      AGENTIC_KANBAN_DIR: gateDataDir,
      KANBAN_TEST_MAX_WORKERS: String(gateMaxWorkers),
      // A board with a fleet configured holds its git/fleet sockets while the gate runs;
      // inheriting those pins makes any suite that opens a listener die with EADDRINUSE and
      // blames the branch for it. See lib/verify-env.ts.
      ...VERIFY_NEUTRALIZED_LISTENER_ENV,
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
    const verifyEnv = docsOnlyGuardsRunApplies
      ? { ...isolationEnv, KANBAN_TEST_GUARDS_ONLY: "1" }
      : effectiveTestScope
        ? {
            ...isolationEnv,
            KANBAN_TEST_PACKAGES: effectiveTestScope,
            ...(fileScope ? { KANBAN_TEST_FILES: changedFiles.join(",") } : {}),
          }
        : isolationEnv;
    if (docsOnlyGuardsRunApplies) {
      console.log(`[pre-merge-gate] docs-only diff for workspace ${workspace.id} (${changedFiles.length} file(s)) — running @gate:always-run guard suites only`);
    }
    if (fileScope) {
      console.log(`[pre-merge-gate] file-scoping verify tests to ${changedFiles.length} changed file(s) for workspace ${workspace.id}`);
    }
    gateTierInfo = {
      strategy: gateStrategy,
      packageScoped: Boolean(effectiveTestScope) && !docsOnlyGuardsRunApplies,
      fileScoped: fileScope && !docsOnlyGuardsRunApplies,
      ...(docsOnlyGuardsRunApplies ? { guardsOnly: true } : {}),
      changedFileCount: changedFiles.length,
      guardSuiteCount: countAlwaysRunGuardSuites(workingDir),
      maxWorkers: gateMaxWorkers,
      // #909: was the worker count DERIVED from live capacity, or pinned (env override / a
      // capacity-read failure that fell back to the pref)? A level may only weaken
      // verification visibly — the same rule that makes `buildersQuiesced` explicit below.
      maxWorkersDerived: resolvedWorkers.derived,
      hostFreeGb: resolvedWorkers.hostFreeGb,
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
    const runVerify = () =>
      runUnderBuildSemaphore(() =>
        runSetupScript(workingDir, verifyScript!, { timeoutMs: verifyTimeoutMs, env: verifyEnv }).catch((e) => ({
          exitCode: 1,
          stdout: "",
          stderr: String(e),
          timedOut: false,
        })),
      );
    // #169's install retry and #894's targeted flake retry both answer ONE question - "is this
    // failure the code's fault?" - and inlined here they took runPreMergeGate past the
    // god-module gate's branch ceiling. They live in verify-retry-strategies.ts now; everything
    // that needs a worktree, the database or the build semaphore is injected below.
    //
    // #903 — the WHOLE chain (first run + any install/flake retry) runs under the
    // cross-workspace verify-chain semaphore, not just each individual invocation. Two
    // different workspaces' chains used to freely interleave inside `runUnderBuildSemaphore`'s
    // own cap (default 2), which is what let three full-suite runs contend on one box at once.
    const outcome = await runUnderVerifyChainSemaphore(async () =>
      resolveVerifyOutcome({
        result: await runVerify(),
        runVerify,
        runVerifyWithRetryScope: (retryScope) =>
          runUnderBuildSemaphore(() =>
            runSetupScript(workingDir, verifyScript!, {
              timeoutMs: verifyTimeoutMs,
              env: { ...verifyEnv, KANBAN_RETRY_TEST_FILES: retryScope },
            }).catch((e) => ({ exitCode: 1, stdout: "", stderr: String(e), timedOut: false })),
          ),
        getInstallCommand: () => getProjectSetupScript(projectId, database).catch(() => null),
        runInstall: async (command) => {
          await runUnderBuildSemaphore(() =>
            runSetupScript(workingDir, command, {
              timeoutMs: DEFAULT_SETUP_SCRIPT_TIMEOUT_MS,
              env: gradleEnv,
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
    );
    if (outcome.failure) {
      return { passed: false, skipped: false, stage: "verify", ...outcome.failure };
    }
    // Carried on the tier info so the PASSING message names it (see GateTierInfo).
    if (gateTierInfo && outcome.flakeRetryNote) gateTierInfo.flakeRetryNote = outcome.flakeRetryNote;
    // #915 — a suite #894 just cleared with a targeted re-run is exactly what the red-debt
    // ledger's `flaky` tag exists for. Extracted (rather than inlined) so this branchy-by-nature
    // best-effort loop does not count against `runPreMergeGate`'s own god-module branch budget.
    await recordFlakySuitesAsRedDebt({ flakySuites: outcome.flakySuites, projectId, workingDir, database });
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
      isSelfProject: isSelfProjectRepo(await getProjectRepoPath(projectId, database)),
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
        const smoke = await runUnderBuildSemaphore(() => runSmokeCheck(workspace.workingDir!, smokeCheck));
        if (!smoke.passed) {
          return { passed: false, skipped: false, stage: "smoke", message: `smoke check failed: ${smoke.message}` };
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
