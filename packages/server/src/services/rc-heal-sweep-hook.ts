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
