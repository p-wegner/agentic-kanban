/**
 * The implement-exit check: what the BOARD runs once when a builder's implementation phase ends,
 * before it launches review.
 *
 * It replaced the `scoped-typecheck.js` / `scoped-vitest.js` Claude Code Stop hooks. A hook fires on
 * every agent stop (mid-phase turns, clarifying questions, review sessions, reconcilers,
 * interactive sessions), cannot see the workflow phase or the ticket group, never went through
 * verify-chain admission (`machine-capacity.ts`, #1160), and never reached the outcome ledger. The
 * board knows all four, so the check lives here and runs once per phase exit.
 *
 * The level comes from the risk posture (`RiskPosture.implementExitCheck`,
 * `implementExitCheckForLevel`):
 *  - `typecheck` runs the stack profile's typecheck command (`pnpm typecheck` on this repo);
 *  - `impact` runs the verify script with the env the pre-merge gate builds for its `impact` tier
 *    (`KANBAN_TEST_SELECTOR=impact`, `KANBAN_IMPACT_BASE`, `KANBAN_TEST_NEW_FILES`, the #1260
 *    budget) — the same resolvers, called with the strategy forced to `impact`;
 *  - `full` runs the verify script unscoped, as the `full` tier does.
 *
 * Every run is ADMITTED the way a gate is: the host-admission floor first (#1057), then the
 * cross-workspace verify-chain semaphore (#903/#1160) at `background` priority, so a merge gate
 * waiting for a slot goes first. A run the host cannot admit is `held`, not red. Test runs are
 * recorded in the outcome ledger with source `implement-exit`, so their cost and miss rate are
 * visible beside the gate's (`ci`) rows without being counted as merge gates.
 *
 * This module only RUNS the check. What the board does with the verdict (launch review, send the
 * builder one feedback turn, mark the workspace for attention) is `startup/exit/implement-exit-check.ts`.
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImplementExitCheckLevel } from "@agentic-kanban/shared/types";
import { runSetupScript, type SetupScriptResult } from "@agentic-kanban/shared/lib/setup-script";
import { createManagedTempDir, type ManagedTempDir } from "@agentic-kanban/shared/lib/temp-dir";
import { testPackagesEnvValue } from "@agentic-kanban/shared/lib/changed-packages";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { Database } from "../db/index.js";
import { getChangedFileNames } from "./git.service.js";
import { getStackProfile } from "./stack-profile.service.js";
import { describeGateHold, resolveGateHostAdmission } from "./gate-quiesce.js";
import { runUnderBuildSemaphore } from "./jvm-build-semaphore.js";
import { runUnderVerifyChainSemaphoreTimed } from "./verify-chain-semaphore.js";
import {
  buildVerifyEnv,
  resolveGateFileScopeEmission,
  resolveGateScoping,
  resolveGateVerification,
  resolveImpactSelectorEnv,
  type GateTierInfo,
  type VerifyGateStrategy,
} from "./pre-merge-gate-tier.js";
import { resolveVerifyFileScope, resolveVerifyMaxWorkers, resolveVerifyTimeoutMs } from "./verify-tunables.js";
import { buildVerifyResourceEnv } from "./verify-resource-env.js";
import { resolveVerifyOutcome, type VerifyOutcome } from "./verify-retry-strategies.js";
import { summarizeVerifyFailure } from "./verify-failure-summary.js";
import { recordVerifyGateOutcome, resolveGateImpactTierFields } from "./test-impact-outcome.service.js";
import { VERIFY_NEUTRALIZED_DB_LOCATION_ENV, VERIFY_NEUTRALIZED_LISTENER_ENV } from "../lib/verify-env.js";
import { getProjectRepoPath } from "../repositories/project.repository.js";
import { isSelfProjectRepo } from "./self-project.js";

/** The outcome-ledger `source` of an implement-exit run (a merge gate row is `ci`). */
export const IMPLEMENT_EXIT_LEDGER_SOURCE = "implement-exit";

/** Hang guard for the typecheck-only level. `pnpm typecheck` here is ~10-60 s. */
const IMPLEMENT_EXIT_TYPECHECK_TIMEOUT_MS = 20 * 60 * 1000;

export interface ImplementExitCheckWorkspace {
  id: string;
  workingDir: string | null;
  baseBranch: string | null;
}

export interface ImplementExitCheckResult {
  level: ImplementExitCheckLevel;
  /** False when nothing ran (level `none`, nothing configured, no worktree, host held). */
  ran: boolean;
  /** True when the check ran and passed, or when nothing ran. A held check is `passed: true`. */
  passed: boolean;
  /** The host could not admit a verify chain; the check was skipped, not failed. */
  held: boolean;
  /** One line for the log and the review/attention text. */
  message: string;
  /** On red: what the builder is told — the failing suites or the typecheck errors. */
  failureDetail: string | null;
  /** How many test files the impact selection kept; null when no selection applied. */
  selectionSize: number | null;
  durationMs: number;
}

/** What one run will execute — decided before anything is spawned (pure). */
export type ImplementExitRunPlan =
  | { kind: "skip"; reason: string }
  | { kind: "typecheck"; command: string }
  | { kind: "verify"; strategy: Extract<VerifyGateStrategy, "impact" | "full">; command: string };

/**
 * DECISION (pure): what the check runs for this level and configuration. A missing command
 * degrades VISIBLY to a skip with its reason — the merge gate still runs, so a project with no
 * typecheck or verify command loses the early signal, not a gate.
 */
export function planImplementExitRun(input: {
  level: ImplementExitCheckLevel;
  workingDir: string | null;
  typecheckCommand: string | null;
  verifyScript: string | null;
}): ImplementExitRunPlan {
  if (input.level === "none") return { kind: "skip", reason: "the posture asks for no implement-exit check" };
  if (!input.workingDir) return { kind: "skip", reason: "the workspace has no worktree" };
  if (input.level === "typecheck") {
    const command = input.typecheckCommand?.trim();
    return command
      ? { kind: "typecheck", command }
      : { kind: "skip", reason: "the project has no typecheck command" };
  }
  const script = input.verifyScript?.trim();
  if (!script) return { kind: "skip", reason: "the project has no verify_script" };
  return { kind: "verify", strategy: input.level, command: script };
}

export interface RunImplementExitCheckArgs {
  workspace: ImplementExitCheckWorkspace;
  projectId: string;
  level: ImplementExitCheckLevel;
  database: Database;
}

function skipped(level: ImplementExitCheckLevel, message: string, held = false): ImplementExitCheckResult {
  return { level, ran: false, passed: true, held, message, failureDetail: null, selectionSize: null, durationMs: 0 };
}

async function readTypecheckCommand(projectId: string, database: Database): Promise<string | null> {
  return (await getStackProfile(projectId, database).catch(() => null))?.typecheckCommand?.trim() || null;
}

/** Run the implement-exit check for one workspace. Total: never throws. */
export async function runImplementExitCheck(args: RunImplementExitCheckArgs): Promise<ImplementExitCheckResult> {
  const { workspace, projectId, level, database } = args;
  if (level === "none") return skipped(level, "implement-exit check: none (posture)");
  const verification = level === "typecheck"
    ? null
    : await resolveGateVerification(projectId, database, { workingDir: workspace.workingDir }).catch(() => null);
  const plan = planImplementExitRun({
    level,
    workingDir: workspace.workingDir,
    typecheckCommand: level === "typecheck" ? await readTypecheckCommand(projectId, database) : null,
    verifyScript: verification?.verifyScript ?? null,
  });
  if (plan.kind === "skip") return skipped(level, `implement-exit check skipped: ${plan.reason}`);

  const admission = await resolveGateHostAdmission({ projectId, database }).catch(
    () => ({ admit: true, reason: "host_has_room" }) as Awaited<ReturnType<typeof resolveGateHostAdmission>>,
  );
  if (!admission.admit) {
    return skipped(level, `implement-exit check held: ${describeGateHold(admission, projectId).message}`, true);
  }
  const startedAt = Date.now();
  try {
    return plan.kind === "typecheck"
      ? await runTypecheckLevel(workspace, plan.command, startedAt)
      : await runVerifyLevel({ ...args, workingDir: workspace.workingDir!, plan, verification: verification! }, startedAt);
  } catch (err) {
    // Fail OPEN: the check is an early signal and the merge gate still runs. A broken harness
    // must not strand finished work, but it must say so.
    return {
      ...skipped(level, `implement-exit check errored (review proceeds, the merge gate still runs): ${errorMessage(err)}`),
      durationMs: Date.now() - startedAt,
    };
  }
}

async function runTypecheckLevel(
  workspace: ImplementExitCheckWorkspace,
  command: string,
  startedAt: number,
): Promise<ImplementExitCheckResult> {
  const { result } = await runUnderVerifyChainSemaphoreTimed(
    () => runUnderBuildSemaphore(() =>
      runSetupScript(workspace.workingDir!, command, {
        timeoutMs: IMPLEMENT_EXIT_TYPECHECK_TIMEOUT_MS,
        env: buildVerifyResourceEnv(2),
      }).catch((err): SetupScriptResult => ({ exitCode: -1, stdout: "", stderr: errorMessage(err) }))),
    `implement-exit typecheck for workspace ${workspace.id}`,
    { priority: "background" },
  );
  const passed = result.exitCode === 0 && !result.timedOut && !result.noProgress;
  const durationMs = Date.now() - startedAt;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  return {
    level: "typecheck",
    ran: true,
    passed,
    held: false,
    message: passed
      ? `implement-exit typecheck passed (\`${command}\`, ${Math.round(durationMs / 1000)}s)`
      : `implement-exit typecheck FAILED (\`${command}\`, exit ${result.exitCode}${result.timedOut ? ", timed out" : ""})`,
    failureDetail: passed ? null : output.slice(-4000),
    selectionSize: null,
    durationMs,
  };
}

interface VerifyLevelArgs extends RunImplementExitCheckArgs {
  workingDir: string;
  plan: Extract<ImplementExitRunPlan, { kind: "verify" }>;
  verification: Awaited<ReturnType<typeof resolveGateVerification>>;
}

function createIsolationDir(): ManagedTempDir {
  try {
    return createManagedTempDir("kanban-implement-exit-");
  } catch {
    // Never given a real disposer: removing tmpdir() itself would be catastrophic.
    return { path: tmpdir(), dispose: () => true, disposeAsync: async () => true };
  }
}

/** The verify env the pre-merge gate would build for this strategy, plus the gate's isolation (#231). */
async function buildImplementExitVerifyEnv(args: VerifyLevelArgs, dataDir: string, changedFiles: string[]) {
  const { workspace, projectId, database, workingDir, plan, verification } = args;
  const strategy = plan.strategy;
  const testScope = testPackagesEnvValue(changedFiles);
  const scoping = resolveGateScoping({
    strategy,
    testScope,
    fileScopePref: testScope ? await resolveVerifyFileScope(projectId, database) : false,
    changedFileCount: changedFiles.length,
  });
  const emission = resolveGateFileScopeEmission({
    env: process.env,
    fileScoped: scoping.fileScoped,
    changedFileCount: changedFiles.length,
    strategy,
    budget: verification.budget,
  });
  const env = buildVerifyEnv({
    isolationEnv: {
      AGENTIC_KANBAN_DIR: dataDir,
      ...VERIFY_NEUTRALIZED_LISTENER_ENV,
      // After AGENTIC_KANBAN_DIR: KANBAN_DB_URL would otherwise outrank it (see lib/verify-env.ts).
      ...VERIFY_NEUTRALIZED_DB_LOCATION_ENV,
    },
    guardsOnly: false,
    impactEnv: resolveImpactSelectorEnv({
      strategy,
      baseBranch: workspace.baseBranch,
      changedFiles,
      fileExists: (file) => existsSync(join(workingDir, file)),
      budget: verification.budget,
    }),
    packagesEnv: scoping.packagesEnv,
    emitFileScope: emission.emitFileScope,
    changedFiles,
    guardsAtMerge: verification.guardsAtMerge,
  });
  const tierInfo: GateTierInfo = {
    strategy,
    selector: emission.selector,
    ...(await resolveGateImpactTierFields({
      applies: emission.selector === "impact",
      workingDir,
      baseBranch: workspace.baseBranch,
      budget: verification.budget?.value ?? null,
      unioned: emission.unioned,
    })),
    packageScoped: Boolean(scoping.packagesEnv),
    fileScoped: emission.emitFileScope,
    changedFileCount: changedFiles.length,
    guardSuiteCount: 0,
    guardsAtMerge: verification.guardsAtMerge,
    maxWorkers: 0,
  };
  return { env, tierInfo };
}

/**
 * The `impact` / `full` levels: the project's verify script, with the env the pre-merge gate
 * builds for that tier, run through the gate's own outcome resolver (one targeted flake re-run,
 * no install retry) and recorded in the outcome ledger.
 */
async function runVerifyLevel(args: VerifyLevelArgs, startedAt: number): Promise<ImplementExitCheckResult> {
  const { workspace, projectId, database, workingDir, plan } = args;
  const changedFiles = workspace.baseBranch
    ? await getChangedFileNames(workingDir, workspace.baseBranch).catch(() => [] as string[])
    : [];
  const dataDir = createIsolationDir();
  try {
    const { env: verifyEnv, tierInfo } = await buildImplementExitVerifyEnv(args, dataDir.path, changedFiles);
    const verifyTimeoutMs = await resolveVerifyTimeoutMs(projectId, database);
    const run = (extraEnv: Record<string, string> = {}) => runUnderBuildSemaphore(async () => {
      const workers = await resolveVerifyMaxWorkers(projectId, database);
      tierInfo.maxWorkers = workers.workers;
      return runSetupScript(workingDir, plan.command, {
        timeoutMs: verifyTimeoutMs,
        env: { ...verifyEnv, ...buildVerifyResourceEnv(workers.workers), ...extraEnv },
      }).catch((e) => ({ exitCode: 1, stdout: "", stderr: String(e), timedOut: false }));
    });
    const projectRepoPath = await getProjectRepoPath(projectId, database).catch(() => null);
    const { result: outcome } = await runUnderVerifyChainSemaphoreTimed(
      async (): Promise<VerifyOutcome> => resolveVerifyOutcome({
        result: await run(),
        runVerify: () => run(),
        runVerifyWithRetryScope: (retryScope) => run({ KANBAN_RETRY_TEST_FILES: retryScope }),
        // No install retry: missing deps in a builder's worktree are the builder's to fix, and the
        // feedback turn names the error. The merge gate keeps its own #169 retry.
        getInstallCommand: async () => null,
        runInstall: async () => undefined,
        looksLikeMissingDeps: () => false,
        scoped: isSelfProjectRepo(projectRepoPath),
        workingDir,
        verifyTimeoutMs,
        projectId,
        workspaceId: workspace.id,
        summarize: (stdout, stderr) => summarizeVerifyFailure(stdout, stderr, workspace.id),
      }),
      `implement-exit ${plan.strategy} check for workspace ${workspace.id}`,
      { priority: "background" },
    );
    const ledger = await recordVerifyGateOutcome({
      workspaceId: workspace.id,
      workingDir,
      repoPath: projectRepoPath,
      baseBranch: workspace.baseBranch,
      outcome,
      tierInfo,
      source: IMPLEMENT_EXIT_LEDGER_SOURCE,
    });
    return describeVerifyOutcome({
      strategy: plan.strategy,
      outcome,
      failedSuites: ledger.failedSuites ?? [],
      selectionSize: tierInfo.impactSelection?.selectedCount ?? null,
      durationMs: Date.now() - startedAt,
    });
  } finally {
    if (!dataDir.dispose()) {
      console.warn(`[implement-exit] could not remove data dir ${dataDir.path} for workspace ${workspace.id} — a verify child may still hold it`);
    }
  }
}

function describeVerifyOutcome(input: {
  strategy: "impact" | "full";
  outcome: VerifyOutcome;
  failedSuites: string[];
  selectionSize: number | null;
  durationMs: number;
}): ImplementExitCheckResult {
  const { strategy, outcome, failedSuites, selectionSize, durationMs } = input;
  const scopeLabel = strategy === "impact"
    ? `impact selection${selectionSize === null ? ", size unknown" : ` of ${selectionSize} test file(s)`}`
    : "full verify";
  const passed = outcome.failure === null;
  const suitesBlock = failedSuites.length > 0 ? `Failing suites:\n${failedSuites.map((s) => `- ${s}`).join("\n")}` : "";
  return {
    level: strategy,
    ran: true,
    passed,
    held: false,
    message: passed
      ? `implement-exit check passed (${scopeLabel}, ${Math.round(durationMs / 1000)}s)${outcome.flakeRetryNote ? ` ${outcome.flakeRetryNote}` : ""}`
      : `implement-exit check FAILED (${scopeLabel}${failedSuites.length > 0 ? `, ${failedSuites.length} failing suite(s)` : ""})`,
    failureDetail: passed ? null : [suitesBlock, outcome.failure!.message].filter(Boolean).join("\n\n").slice(0, 6000),
    selectionSize,
    durationMs,
  };
}
