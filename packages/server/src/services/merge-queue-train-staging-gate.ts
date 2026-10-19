// Staging gate + base-alone control arm for a release train, split out of merge-queue-train.ts (#1605).
import { trainGateWorkerName } from "./merge-train-placement.js";
import type { Database } from "../db/index.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import * as gitService from "./git.service.js";
import { gitExec, gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { runMergeTrain, trainRefName } from "./merge-train.service.js";
import { isInconclusiveGate } from "./merge-queue-train-inconclusive.js";
import { provisionTrainGateSelector } from "./merge-train-gate-selector.js";
import { runPreMergeGate } from "./pre-merge-gate.service.js";
import { runStaticTierGate } from "./static-tier.service.js";
import { resolveWorktreeClaims, removeWorktreeUnlessShared } from "@agentic-kanban/shared/lib/worktree-claim";
import type { MergeTrainAttemptDto, MergeTrainBaseVerdict } from "@agentic-kanban/shared/types";
import { type AgentFixGateVerdict, type AgentFixOutcome } from "./merge-train-agent-fix.js";
import { getBaseBranchHealthForSha, isBaseHealthAnswer } from "../repositories/base-branch-health.repository.js";
import { getProjectSetupScript } from "../repositories/stack-profile.repository.js";
import { DEFAULT_SETUP_SCRIPT_TIMEOUT_MS, runSetupScript } from "@agentic-kanban/shared/lib/setup-script";
import { noteMergeGatePhase } from "./merge-job.service.js";
import { decideRegate, describeFullRegate, describeTargetedRegate } from "./merge-train-targeted-regate.js";


/** What one staging gate reports back. `stage`/`failedSuites` ride along on a red run only. */
export interface TrainStagingGateResult {
  passed: boolean;
  message: string;
  sided?: Array<{ workspaceId: string; reason: string }>;
  /** Which stage decided a red run: the gate's own `verify`/`smoke`, the worktree `setup`, or `none` (could not run). */
  stage?: "verify" | "smoke" | "setup" | "none";
  failedSuites?: string[];
  guardFailure?: boolean;
  /** #1277 — the fix agent's row (and, when its re-gate was green, the fixed train tip); see `TrainGate`. */
  agentFix?: { attempt: MergeTrainAttemptDto; fixedTrainSha?: string };
  /** #1413 — the gate was killed/timed out/held rather than judging the tree; see `TrainGate`. */
  inconclusive?: boolean;
}

/**
 * ONE staging gate: a fresh worktree at `ref`, the project's setup script run against it the way
 * a real workspace's is, then `runPreMergeGate`. Extracted to module scope (#1204) because the
 * CONTROL ARM needs exactly this against the BARE BASE, and a second copy of a gate is the last
 * thing this area needs - the train's own `runGate` is now a thin wrapper around it plus the
 * train-scoped review.
 *
 * `afterGreen` runs INSIDE the worktree's lifetime, before teardown, and is where the review
 * lives; a control-arm gate passes none. Fails CLOSED on a throw: a gate we could not run is not
 * a gate that passed.
 */
export async function runTrainStagingGate(args: {
  database: Database;
  repoPath: string;
  baseBranch: string;
  projectId: string;
  ref: string;
  attemptLabel: string;
  /** The REAL workspaces whose deferred installs this gate must clear; empty for a control arm. */
  includedWorkspaceIds: string[];
  afterGreen?: (ctx: { gateWorktree: string; gateMessage: string }) => Promise<{ sided?: Array<{ workspaceId: string; reason: string }> }>;
  /**
   * #1277 — runs INSIDE the worktree's lifetime when the gate went red: the in-train fix agent.
   * `regate` re-runs the same gate on the worktree's current tree. Returns null to decline.
   */
  onRed?: (ctx: {
    gateWorktree: string;
    message: string;
    failedSuites?: string[];
    regate: () => Promise<AgentFixGateVerdict>;
  }) => Promise<AgentFixOutcome | null>;
  /**
   * #1203 — real cancellation. Passed into the setup script AND the verify gate, so a cancel
   * kills whichever child process is currently running rather than letting it finish before the
   * row's `abandoned` state is noticed. Absent means "never aborts" (the control-arm caller has
   * nothing to cancel).
   */
  signal?: AbortSignal;
  /** #1633 — files the first gate covered (members' changed files); enables the targeted re-gate after a shepherd fix. */
  coveredFiles?: readonly string[];
  /** #1463 — a queue flush's gate script, run instead of the project's verify command. */
  verifyScriptOverride?: string;
}): Promise<TrainStagingGateResult> {
  const { database, repoPath, baseBranch, projectId, ref, attemptLabel, signal } = args;
  let gateWorktree: string | null = null;
  try {
    // #713: DB-backed claim guard alongside the namespace - the train leaf lives
    // under the same `.worktrees` root as every live workspace's.
    gateWorktree = await gitService.createWorktree(repoPath, ref, undefined, {
      pathNamespace: "train",
      ...(await resolveWorktreeClaims(database, { label: "merge-train-gate" })),
    });
    // The test-impact selector + map, by the builder's own road (#1039); logs `selector ABSENT` when it cannot.
    await provisionTrainGateSelector({ database, repoPath, projectId, worktreePath: gateWorktree, attemptLabel });
    // #1154: a builder's worktree gets the project's setup/install script run against
    // it before anything else touches it (`workspace-provision.service.ts`); this
    // staging worktree is created fresh by `createWorktree` above with none of that -
    // so on a project whose dependencies are per-worktree (install-per-worktree, not a
    // symlink into main) the train verified a tree that was never actually installed.
    // Provision it the same way a real workspace is, best-effort: a setup failure here
    // is reported through the gate result below rather than thrown, since a project with
    // no setup script configured (installMode "symlink", or none at all) must still gate
    // normally.
    // #1440: on a worker placement the worker installs; the host runs no setup script here.
    const onWorker = (await trainGateWorkerName(projectId, database, attemptLabel)) !== null;
    const setupScript = onWorker ? null : await getProjectSetupScript(projectId, database).catch(() => null);
    if (setupScript && setupScript.trim()) {
      noteMergeGatePhase(`train:${attemptLabel}`, "install", setupScript);
      const setup = await runSetupScript(gateWorktree, setupScript, {
        timeoutMs: DEFAULT_SETUP_SCRIPT_TIMEOUT_MS,
        // #1203: a cancel kills this install too, not only the verify script — an abandoned
        // train must not keep provisioning a worktree nobody will gate.
        signal,
      }).catch((err) => ({ exitCode: 1, stdout: "", stderr: errorMessage(err), timedOut: false }));
      if (setup.exitCode !== 0 && !setup.timedOut) {
        return {
          passed: false,
          stage: "setup",
          message:
            `train staging worktree setup failed (exit ${setup.exitCode}) before the gate could run - ` +
            `dependencies were never installed for this tree, so the gate could not verify anything: ` +
            `${(setup.stderr || setup.stdout || "no output").slice(0, 500)}`,
        };
      }
    }
    // `memberWorkspaceIds`: the synthetic `train:<label>` id matches no `repos` row, so
    // without it the #628 deferred-install check passes vacuously for the whole train.
    const gateOnce = async (scriptOverride?: string) => (await runStaticTierGate(gateWorktree as string, baseBranch, signal, scriptOverride ?? args.verifyScriptOverride)) ?? runPreMergeGate(
      {
        id: `train:${attemptLabel}`,
        workingDir: gateWorktree as string,
        baseBranch,
        // The INCLUDED members (#676) - a member dropped during assembly is not in this
        // tree, so its outstanding install must not withhold the train.
        memberWorkspaceIds: args.includedWorkspaceIds,
      },
      projectId,
      database,
      // #1203: same token — a cancel mid-verify kills the running gate process.
      signal,
      scriptOverride ?? args.verifyScriptOverride,
    );
    let gate = await gateOnce();
    // #1633: the gated tip, so a shepherd fix is the diff on top of it.
    const gatedSha = await gitService.revParse(gateWorktree, "HEAD").catch(() => null);
    // #1277: a red tree gets one directed fix agent, in THIS worktree (deps already installed),
    // before anything is bisected. Each re-gate it asks for runs the same gate; `gate` always
    // holds the latest verdict, so a fixed tree flows on to `afterGreen` like any green one.
    let agentFix: TrainStagingGateResult["agentFix"];
    // #1413: a watchdog kill / timeout / held run (`timedOut`, `held`) is inconclusive, not red —
    // there is nothing for a fix agent to fix, so it never gets one.
    let inconclusive = isInconclusiveGate(gate);
    if (!gate.passed && !inconclusive && args.onRed && !signal?.aborted) {
      const fix = await args.onRed({
        gateWorktree,
        message: gate.message,
        failedSuites: gate.failedSuites,
        regate: async () => {
          const lastFailed = gate.failedSuites;
          // #1633: a small fix inside the covered scope re-gates only what it can affect.
          let note = "";
          let script: string | undefined;
          if (gatedSha && args.coveredFiles && !args.verifyScriptOverride) {
            const fixSha = await gitService.revParse(gateWorktree as string, "HEAD").catch(() => null);
            const diff = await gitExec(["diff", "--name-only", gatedSha, "HEAD"], { cwd: gateWorktree as string });
            const decision = decideRegate({
              fixFiles: diff.error ? [] : diff.stdout.split(/\r?\n/).filter(Boolean),
              coveredFiles: args.coveredFiles, failedSuites: lastFailed, gatedSha, fixSha: fixSha ?? "HEAD",
            });
            if (decision.mode === "targeted") { script = decision.script; note = describeTargetedRegate(decision); }
            else note = describeFullRegate(decision.reason);
            console.log(`[merge-train] ${attemptLabel}: ${note}`);
          }
          gate = await gateOnce(script);
          if (note) gate = { ...gate, message: `${note}\n${gate.message}` };
          return { passed: gate.passed, message: gate.message, failedSuites: gate.failedSuites, ...(isInconclusiveGate(gate) ? { inconclusive: true } : {}) };
        },
      });
      if (fix) agentFix = { attempt: fix.attempt, ...(fix.fixedTrainSha ? { fixedTrainSha: fix.fixedTrainSha } : {}) };
      // #1572: a shepherd that could not be placed (infra) says nothing about the code: inconclusive, never red.
      if (fix?.attempt.verdict === "agent_fix_held") inconclusive = true;
    }
    // #1585: the fix agent's re-gate can be the held/cancelled one — judge the LATEST verdict.
    const finalInconclusive = isInconclusiveGate(gate);
    if (!gate.passed) {
      return {
        passed: false,
        message: gate.message,
        stage: gate.stage,
        ...(gate.failedSuites ? { failedSuites: gate.failedSuites, guardFailure: gate.guardFailure === true } : {}),
        ...(agentFix ? { agentFix } : {}),
        ...(inconclusive || finalInconclusive ? { inconclusive: true } : {}),
      };
    }
    const extra = await args.afterGreen?.({ gateWorktree, gateMessage: gate.message });
    return {
      passed: true,
      message: gate.message,
      ...(extra?.sided && extra.sided.length > 0 ? { sided: extra.sided } : {}),
      ...(agentFix ? { agentFix } : {}),
    };
  } catch (err) {
    // Fail CLOSED: a gate we could not run is not a gate that passed.
    return { passed: false, stage: "none", message: `train gate could not run: ${errorMessage(err)}` };
  } finally {
    // Route the teardown through the #394 co-residency guard rather than deleting
    // outright: this leaf lives under the same `.worktrees` root as every live
    // workspace's, and it was created WITH a claim above - so the claim is exactly
    // what must be consulted before removing it. Enforced by
    // `worktree-delete-guard-ratchet`.
    if (gateWorktree) {
      const dir = gateWorktree;
      await removeWorktreeUnlessShared({
        database,
        workingDir: dir,
        label: "merge-train-gate",
        removeWorktree: () => gitService.removeWorktree(repoPath, dir),
      }).catch(() => undefined);
    }
  }
}

/**
 * The CONTROL ARM (#1204): what does the gate say about the BARE BASE the train was assembled on?
 *
 * Asked once, by `runMergeTrain`, when the FULL train has failed and is about to be halved. A
 * base-health row recorded at that EXACT sha describes this very tree, so it answers for free;
 * otherwise one staging gate runs on a scratch ref at the base sha, with no member aboard.
 *
 * MEASURED motivation: train/2026-09-19-02 bisected a red master 27 times and marked all 14
 * members `gateRejected`. One run at the top of the search answers the question for the whole
 * tree, so 26 of those 27 were avoidable and none of the 14 attributions was true.
 *
 * Returns null when the question could not be asked at all (the base sha would not resolve, the
 * scratch ref could not be minted) - the bisect then proceeds exactly as it did before #1204,
 * rather than a failed probe becoming a verdict about anybody's code.
 */
export async function gateBaseAloneOnce(args: {
  database: Database;
  repoPath: string;
  baseBranch: string;
  projectId: string;
  trainLabel: string;
}): Promise<{ verdict: MergeTrainBaseVerdict; gateRuns: number } | null> {
  const { database, repoPath, baseBranch, projectId, trainLabel } = args;
  const baseSha = await gitService.revParse(repoPath, baseBranch).catch(() => null);
  if (!baseSha) return null;

  const recorded = await getBaseBranchHealthForSha(projectId, baseSha, database).catch(() => null);
  if (recorded && isBaseHealthAnswer(recorded.outcome)) {
    console.log(`[merge-train] ${trainLabel}: control arm answered from base_branch_health at ${baseSha.slice(0, 8)} - base is ${recorded.outcome}, no extra gate run`);
    return { verdict: recorded.outcome === "green" ? "green" : "red", gateRuns: 0 };
  }

  const controlRef = trainRefName(`${trainLabel}-base`);
  try {
    await gitExecOrThrow(["branch", "-f", controlRef, baseSha], { cwd: repoPath });
  } catch (err) {
    console.warn(`[merge-train] ${trainLabel}: control arm could not mint its scratch ref (non-fatal, the bisect proceeds): ${errorMessage(err)}`);
    return null;
  }
  try {
    const gate = await runTrainStagingGate({
      database, repoPath, baseBranch, projectId,
      ref: controlRef,
      attemptLabel: `${trainLabel}-base`,
      includedWorkspaceIds: [],
    });
    console.log(`[merge-train] ${trainLabel}: control arm gated the bare base at ${baseSha.slice(0, 8)} - ${gate.passed ? "green" : "RED"}${gate.passed ? "" : `: ${gate.message.slice(0, 200)}`}`);
    return { verdict: gate.passed ? "green" : "red", gateRuns: 1 };
  } finally {
    await gitExecOrThrow(["branch", "-D", controlRef], { cwd: repoPath }).catch(() => undefined);
  }
}

