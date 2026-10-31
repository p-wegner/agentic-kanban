/**
 * What an rc probe does with its verdict (#1239) — the glue between `runBaseBranchProbe`
 * (`base-branch-health.service.ts`, on the god-module ring, so this is not inlined there) and the
 * rc heal-ticket service.
 *
 * The merge range a heal ticket lists starts at the PREVIOUS GREEN CANDIDATE when one exists —
 * the last tree the full suite passed on — and otherwise at master's last green sweep. The
 * probe hands over the green it already read for the rc's own branch; this looks further only
 * when that is empty, so a re-swept rc that was green before lists just what moved since.
 */
import type { Database } from "../db/index.js";
import { getLastGreenBaseBranchHealth, getShaSweepEvidence } from "../repositories/base-branch-health.repository.js";
import type { BaseBranchVerifyResult } from "./base-branch-health.service.js";
import { reconcileRcSweep, type RcHealResult } from "./rc-heal-ticket.service.js";
import { findRcCandidate, isTerminalRcState, readRcState, resolveStableCheckoutFor } from "./rc-state.js";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";

/**
 * #1789: why a red verdict on this rc must NOT file or refresh a heal ticket, or null when it may.
 * A candidate rc-state marks `abandoned`/`promoted` is dead (a fix merged into it lands nowhere), and an rc
 * whose sha is already contained in a master sha that swept GREEN has nothing left to heal.
 */
export async function rcHealSkipReason(
  args: { projectId: string; branch: string; sha: string; repoPath: string },
  database: Database,
): Promise<string | null> {
  try {
    const candidate = findRcCandidate(readRcState(resolveStableCheckoutFor(args.repoPath)), args.branch);
    if (candidate && isTerminalRcState(candidate.state)) {
      return `${args.branch} is ${candidate.state} in rc-state; a heal ticket for it would fix a dead candidate`;
    }
    const green = await getLastGreenBaseBranchHealth(args.projectId, database).catch(() => null);
    if (green?.sha) {
      const contained = await gitExec(["merge-base", "--is-ancestor", args.sha, green.sha], { cwd: args.repoPath, timeout: 15_000 });
      if (execSucceeded(contained)) {
        return `${args.branch} at ${args.sha.slice(0, 12)} is already contained in the base's green sweep at ${green.sha.slice(0, 12)}; nothing left to heal`;
      }
    }
  } catch {
    // Fail open: an unreadable rc-state or repo must not hide a real red.
  }
  return null;
}

export async function reconcileRcSweepAfterProbe(
  args: {
    projectId: string;
    branch: string;
    result: Pick<BaseBranchVerifyResult, "outcome" | "sha" | "failedSuites" | "message">;
    healthRowId: string | null | undefined;
    repoPath: string;
    verifyScript: string | null;
    /** The rc's own last green, as the probe read it before recording this run. */
    lastGreen: { sha: string; branch: string } | null | undefined;
  },
  database: Database,
): Promise<RcHealResult> {
  const previousGreen = args.lastGreen
    ?? await getLastGreenBaseBranchHealth(args.projectId, database, { anyRc: true }).catch(() => null)
    ?? await getLastGreenBaseBranchHealth(args.projectId, database).catch(() => null);
  // #1681: a red on a sha that already swept green is a load flake until an idle re-run says otherwise.
  const evidence = args.result.outcome === "red" ? await getShaSweepEvidence(args.projectId, args.result.sha, database).catch(() => null) : null;
  if (args.result.outcome === "red") {
    const skip = await rcHealSkipReason({ projectId: args.projectId, branch: args.branch, sha: args.result.sha, repoPath: args.repoPath }, database);
    if (skip) {
      console.log(`[rc-heal] project ${args.projectId}: no heal ticket for red ${args.branch} - ${skip}`);
      return { action: "noop", reason: skip, issueIds: [], issueNumbers: [] };
    }
  }
  return reconcileRcSweep({
    flakeRerunOwed: evidence ? evidence.green && evidence.red <= 1 : false,
    projectId: args.projectId,
    rcBranch: args.branch,
    sha: args.result.sha,
    outcome: args.result.outcome,
    failedSuites: args.result.failedSuites,
    healthRowId: args.healthRowId ?? null,
    message: args.result.message,
    repoPath: args.repoPath,
    lastGreenSha: previousGreen?.sha ?? null,
    lastGreenLabel: previousGreen ? (previousGreen.branch === args.branch ? "this candidate's previous sweep" : previousGreen.branch) : null,
    verifyScript: args.verifyScript,
  }, database);
}
