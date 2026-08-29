/**
 * The #243 merge-gate evidence protocol (#540).
 *
 * Its own module rather than a function inside `pre-merge-gate.service.ts` for one concrete
 * reason: the gate consultation must stay a MODULE BOUNDARY crossing. Every suite that drives a
 * merge path mocks `resolveMergeGate` on that module; folding this protocol in beside it would
 * make the call intra-module and silently bypass those mocks (measured — five suites went red).
 */
import type { Database } from "../db/index.js";
import {
  noteMergeGateAttemptStarted,
  noteMergeGateAttemptFinished,
} from "./merge-job.service.js";
import {
  resolveMergeGate,
  resolveMergeGateShas,
  gateAlreadyPassed,
  RUN_GATE,
  type MergeGateShas,
  type MergeGateToken,
  type PreMergeGateResult,
  type PreMergeGateWorkspace,
  type ResolvedMergeGate,
} from "./pre-merge-gate.service.js";

/**
 * Which tip (if any) moved between the two reads around a gate run. `undefined` on either side
 * means "unresolvable" — a diagnostic read failure must not be reported as movement, which is
 * why only a known-to-known change counts.
 */
export function movedDuringGate(before: MergeGateShas, after: MergeGateShas): "branch" | "base" | null {
  if (before.branchSha && after.branchSha && before.branchSha !== after.branchSha) return "branch";
  if (before.baseSha && after.baseSha && before.baseSha !== after.baseSha) return "base";
  return null;
}

/** Outcome of {@link runGateWithEvidence}. */
export interface GateWithEvidence {
  /** Whether the merge may proceed. */
  passed: boolean;
  /** True when the gate actually RAN (false = nothing configured to gate on). */
  ran: boolean;
  stage: PreMergeGateResult["stage"];
  message: string;
  /** See {@link PreMergeGateResult.unverified} — nothing checked this merge at all (#377). */
  unverified?: boolean;
  /** The tips read BEFORE the run — the state the gate actually verified. */
  shasBefore: MergeGateShas;
  /** Which tip moved WHILE the gate ran, if any. */
  moved: "branch" | "base" | null;
  /**
   * Stamped when the gate FINISHED. Callers must use this rather than a timestamp captured
   * before the run: on a repo whose gate is a full suite + build that is 30-45 minutes of
   * difference, and evidence born older than {@link MERGE_GATE_EVIDENCE_MAX_AGE_MS} can never
   * be accepted.
   */
  ranAt: string;
  /**
   * Proof for the verified state, or null when there is none worth trusting — the gate
   * failed, it did not run, or a tip moved during the run. A null token means the caller
   * must let the merge executor gate again rather than assert verification it does not have.
   */
  token: MergeGateToken | null;
  /**
   * Wall-clock milliseconds the gate run took (#906) — bracketed around `runGate` here, the
   * one choke point every caller already goes through, so gate cost is measurable without
   * hand-copying `Date.now()` pairs into four call sites again.
   */
  durationMs: number;
}

/**
 * The #243 evidence protocol, once: pin the tips BEFORE the gate → run it → re-resolve AFTER
 * → mint proof for the BEFORE tips, or withhold it when either tip moved.
 *
 * The gate is a 20-40 minute build+test run and nothing stops a still-active builder (or a
 * human) committing into the worktree while it runs, so tips read afterwards can name a commit
 * the gate never saw. Evidence minted WITHOUT tips falls back to `evidenceIsValid`'s 15-minute
 * age check with a `ranAt` stamped at gate END — so a commit landing mid-gate produced evidence
 * that looked FRESH, and the moved tip merged having never been tested.
 *
 * The minted evidence deliberately carries the BEFORE tips: they are what the run actually
 * tested. They equal the after tips whenever a token is minted at all (nothing moved), so this
 * is a statement of intent rather than a behaviour difference — evidence must never name a tip
 * the gate did not see.
 *
 * This was hand-copied into four callers (pre-lock merge gate, review-exit, and both
 * monitor-cycle merge paths) and drifted in each: two omitted the tips entirely (#573), one
 * omitted `baseBranch` from the gate workspace, and only two re-resolved afterwards.
 */
export async function runGateWithEvidence(args: {
  workspace: PreMergeGateWorkspace;
  projectId: string | null;
  /** Which path ran the gate, recorded on the evidence for logs/diagnostics. */
  source: string;
  database: Database;
  /** Injectable tip reader, so a test can pin the before/after pair without a real repo. */
  readShas?: (workspace: PreMergeGateWorkspace) => Promise<MergeGateShas>;
  /** Injectable gate runner, so a test can exercise the protocol without a 20-minute build. */
  runGate?: (
    workspace: PreMergeGateWorkspace,
    projectId: string | null,
    database: Database,
  ) => Promise<Omit<ResolvedMergeGate, "decision">>;
}): Promise<GateWithEvidence> {
  const { workspace, projectId, source, database } = args;
  const readShas = args.readShas ?? resolveMergeGateShas;
  const runGate = args.runGate ?? ((workspace_, projectId_, database_) =>
    resolveMergeGate({ token: RUN_GATE, workspace: workspace_, projectId: projectId_, database: database_ }));
  const shasBefore = await readShas(workspace);
  const startedAtMs = Date.now();
  // #936 — this is the ONE choke point every gate run passes through, so it is where a merge
  // job learns that it made another attempt. Before this, `merge-status` read a bare
  // `{"state":"running"}` for hours across multiple complete 20-minute suite runs, which is
  // indistinguishable from a hang. A gate that runs outside a merge job (the monitor's own
  // cycle gate, review-exit) records nothing — `noteMergeGateAttemptStarted` returns null.
  const attempt = noteMergeGateAttemptStarted(workspace.id, source);
  let result: Omit<ResolvedMergeGate, "decision">;
  try {
    result = await runGate(workspace, projectId, database);
  } catch (err) {
    noteMergeGateAttemptFinished(workspace.id, attempt, {
      outcome: "failed",
      detail: `gate run threw: ${err instanceof Error ? err.message : String(err)}`,
    });
    throw err;
  }
  const durationMs = Date.now() - startedAtMs;
  const ranAt = new Date().toISOString();
  const shasAfter = await readShas(workspace);
  const moved = movedDuringGate(shasBefore, shasAfter);

  // Minted for any PASS whose tips held still — including a pass with nothing to gate on
  // (stage "none"). Callers that only want proof of a REAL run check `ran` first, as the
  // pre-lock gate does; the monitor and review-exit paths deliberately carry the no-op pass
  // forward so the executor does not re-ask a question already answered.
  const token = result.passed && !moved
    ? gateAlreadyPassed({ ranAt, stage: result.stage, source, branchSha: shasBefore.branchSha, baseSha: shasBefore.baseSha })
    : null;

  // #936 acceptance: "a gate that completes without merging logs WHY, at the workspace level".
  // The expensive-and-silent case is `passed && moved` — a full suite ran to completion and
  // its verdict is thrown away because a tip moved underneath it, which is exactly the
  // "gate #1 completed, no merge, job still running" step nothing accounted for on #926.
  if (result.passed && moved) {
    console.warn(
      `[merge-gate] workspace ${workspace.id}: gate attempt ${attempt?.attempt ?? "?"} (${source}) PASSED after `
        + `${Math.round(durationMs / 1000)}s but its verdict is DISCARDED — the ${moved} tip moved during the run `
        + `(#243), so nothing proves the state about to merge was tested. The gate will run again (#936).`,
    );
  }
  noteMergeGateAttemptFinished(workspace.id, attempt, {
    outcome: !result.passed
      ? "failed"
      : moved
        ? "discarded"
        : result.ran
          ? "passed"
          : "skipped",
    stage: result.stage,
    detail: !result.passed
      ? result.message
      : moved
        ? `gate passed but the ${moved} tip moved during the run — verdict discarded, the gate must run again (#243)`
        : undefined,
  });

  return { ...result, shasBefore, moved, ranAt, token, durationMs };
}
