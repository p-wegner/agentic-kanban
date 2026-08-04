/**
 * Pre-merge gate orchestration for the merge path — extracted from `workspace-merge.service.ts`
 * (which hit the 1000-line god-module ceiling).
 *
 * Two cohesive concerns live here, both about the GATE rather than about merging:
 *   - {@link recordGateFailureNote}: how a withhold is written to the issue timeline, deduped.
 *   - {@link runPreLockGate}: running the gate BEFORE the repo lock is taken, and converting a
 *     pass into an `already-passed` proof token for the merge executor.
 *
 * Why the gate runs before the lock: the gate (`verify_script` — tests + build) takes 20-40
 * minutes on this repo while the git work the lock guards takes seconds. Holding the lock across
 * the gate made it a repo-wide throughput cap — one merge per gate duration — and made a FAILING
 * gate the most expensive case of all, since it blocked every other workspace for its full run
 * and landed nothing (measured: a 41-minute gate that then failed, with three workspaces ready
 * behind it).
 *
 * This is not a weakening of the gate. `already-passed` evidence is exactly what the in-process
 * monitor has always handed the merge path (it gates during its cycle, then merges), and
 * `resolveMergeGate` rejects evidence older than `MERGE_GATE_EVIDENCE_MAX_AGE_MS` by re-running
 * the gate under the lock. A long wait for the lock therefore degrades to precisely the old
 * behaviour; the common case holds the lock for seconds.
 */
import type { workspaces } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import { getLatestIssueCommentByKind } from "../repositories/issue-comments.repository.js";
import { WorkspaceError } from "./workspace-internals.js";
import {
  resolveMergeGate,
  resolveMergeGateShas,
  RUN_GATE,
  gateAlreadyPassed,
  type MergeGateToken,
} from "./pre-merge-gate.service.js";

type WorkspaceRow = typeof workspaces.$inferSelect;

/**
 * The merge service's timeline recorder. `eventType` is a closed union rather than a string, so
 * mistyping an event name is a compile error — keep it that way when threading it through here.
 */
type RecordMergeAttempt = (
  workspace: WorkspaceRow,
  eventType: "conflict" | "fix-and-merge-launched" | "reconcile-launched" | "merged" | "warning" | "already-merged" | "direct-closed" | "gate-failed",
  body: string,
  payload?: Record<string, unknown>,
) => Promise<void>;

/**
 * Record a pre-merge-gate withhold, deduped against the most recent gate-failure note for this
 * issue: an orchestrator tick retries every ~30s, so an unchanged verify/smoke failure would
 * otherwise spam a fresh "merge-attempt" comment every cycle (#170). Only inserts a new note
 * when the gate message actually changed (new failure signature) or none was recorded yet.
 */
export async function recordGateFailureNote(args: {
  workspace: WorkspaceRow;
  stage: string;
  gateMessage: string;
  targetBranch: string;
  database: Database;
  recordMergeAttempt: RecordMergeAttempt;
}): Promise<void> {
  const { workspace, stage, gateMessage, targetBranch, database, recordMergeAttempt } = args;
  try {
    const latest = await getLatestIssueCommentByKind(workspace.issueId, "merge-attempt", database);
    const latestPayload = latest?.payload ? (JSON.parse(latest.payload) as Record<string, unknown>) : null;
    if (latestPayload?.mergeReason === "pre_merge_gate_failed" && latestPayload?.gateMessage === gateMessage) {
      return; // identical failure repeating — already recorded, don't spam another note
    }
  } catch (err) {
    console.warn(
      "[workspace-merge] failed to check prior gate-failure note (non-fatal):",
      err instanceof Error ? err.message : String(err),
    );
  }
  await recordMergeAttempt(
    workspace,
    "gate-failed",
    `Merge withheld: pre-merge gate failed (${stage}). ${gateMessage}`,
    { mergeReason: "pre_merge_gate_failed", gateStage: stage, gateMessage, targetBranch },
  );
}

/**
 * Run the pre-merge gate OUTSIDE the repo lock and return the token the merge executor should
 * use.
 *
 * - Gate fails → throws, WITHOUT the lock ever being taken. That is the point: a red gate must
 *   not block other workspaces from merging.
 * - Gate passes and actually RAN → returns an `already-passed` token carrying the proof, so the
 *   executor does not pay for the same expensive run twice.
 * - Gate was skipped / no project / nothing to gate → returns the caller's original token and
 *   lets the executor resolve it (cheaply) under the lock. A "none" outcome carries no evidence
 *   worth trusting.
 *
 * Callers must invoke this AFTER their refuse/reuse check: when another merge is already in
 * flight the call is going to be refused anyway, and gating first would burn a full test run
 * just to produce that refusal.
 */
export async function runPreLockGate(args: {
  workspaceId: string;
  workspace: WorkspaceRow;
  projectId: string | null;
  baseBranch: string;
  token: MergeGateToken;
  database: Database;
  recordMergeAttempt: RecordMergeAttempt;
}): Promise<MergeGateToken> {
  const { workspaceId, workspace, projectId, baseBranch, token, database, recordMergeAttempt } = args;
  if (!projectId || token.kind !== "run-gate") return token;

  console.log(`[workspace-merge] pre-lock gate phase=start workspaceId=${workspaceId}`);
  const preGate = await resolveMergeGate({
    token: RUN_GATE,
    // `baseBranch` matters: without it the gate cannot read the diff, so every diff-derived
    // cost decision silently degrades to its most expensive branch — the docs-only skip
    // (#198) could never fire on the merge path, and the test-package scoping cannot either.
    // The value is already in hand from the caller; omitting it was pure loss.
    workspace: { id: workspaceId, workingDir: workspace.workingDir, baseBranch },
    projectId,
    database,
  });

  if (!preGate.passed) {
    await recordGateFailureNote({
      workspace,
      stage: preGate.stage,
      gateMessage: preGate.message,
      targetBranch: baseBranch,
      database,
      recordMergeAttempt,
    });
    throw new WorkspaceError(
      `Pre-merge gate failed (${preGate.stage}) — merge withheld. ${preGate.message}`,
      "CONFLICT",
      { mergeReason: "pre_merge_gate_failed", gateStage: preGate.stage },
    );
  }

  if (!preGate.ran) return token;

  console.log(
    `[workspace-merge] pre-lock gate passed workspaceId=${workspaceId} stage=${preGate.stage}; acquiring lock`,
  );
  // Pin the evidence to the exact state that was verified. This is what lets the in-lock
  // re-resolve accept the pass after an arbitrarily long lock wait (no pointless re-gate)
  // while still catching the case that genuinely invalidates it: another merge landed and
  // moved the base, so the merge RESULT is no longer what was tested.
  const shas = await resolveMergeGateShas({ id: workspaceId, workingDir: workspace.workingDir, baseBranch });
  return gateAlreadyPassed({
    ranAt: new Date().toISOString(),
    stage: preGate.stage,
    source: "pre-lock-merge",
    branchSha: shas.branchSha,
    baseSha: shas.baseSha,
  });
}
