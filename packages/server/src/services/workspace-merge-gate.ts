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
import type { MergeGateToken } from "./pre-merge-gate.service.js";
import { runGateWithEvidence } from "./merge-gate-evidence.js";

// The #243 sha comparison moved next to the protocol that uses it (#540). Re-exported here
// because this is the path callers and suites already import it from.
export { movedDuringGate } from "./merge-gate-evidence.js";
import { getBaseBranchHealthAtMergeBase, describeRedBaseAttribution } from "./base-branch-health.service.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

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
/**
 * The `mergeReason` tag a pre-merge-gate withhold carries on its `WorkspaceError`.
 *
 * The withhold uses the "CONFLICT" error CODE (for HTTP-status purposes) but is emphatically
 * not a merge conflict, and every caller that recovers from a merge failure has to tell the
 * two apart. Callers used to sniff for this themselves, or — worse — not at all: #638 was the
 * monitor treating a red verify gate exactly like a dirty worktree and handing it to
 * fix-and-merge, which merges without ever running the gate.
 */
export const PRE_MERGE_GATE_FAILURE_REASON = "pre_merge_gate_failed";

/**
 * True when a rejected merge was withheld BY THE GATE rather than by a conflict/lock/etc.
 *
 * A batch reconciler or fix agent cannot fix a red verify script, so this is the predicate
 * that keeps such a failure out of every agent-driven retry path (#170 for the merge queue,
 * #638 for the monitor). It reads the structured `data.mergeReason` the withhold sets — never
 * the message text, which is localized prose.
 */
export function isPreMergeGateFailure(err: unknown): boolean {
  const data = err instanceof Error ? (err as unknown as { data?: { mergeReason?: string } }).data : undefined;
  return data?.mergeReason === PRE_MERGE_GATE_FAILURE_REASON;
}

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
      errorMessage(err),
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
 * Record that a merge was verified by NOTHING, because the project has nothing to verify with (#377).
 *
 * MEASURED reason this exists: eight tickets were auto-merged into a project with no `verify_script`
 * and an all-null stack profile. One carried a test that could never pass, master went 38/38 green to
 * 40-with-1-permanently-failing, and no signal was produced anywhere — because "no gate configured"
 * and "gate passed" were both `passed: true` with identical silence. A merge nothing checked is a
 * fact about that merge and belongs on the timeline beside it.
 *
 * Deduped like {@link recordGateFailureNote}: the state is a property of the PROJECT, so it repeats on
 * every merge and would otherwise become noise nobody reads. Non-fatal throughout — an unrecordable
 * note must never be the thing that stops a merge.
 */
export async function recordUnverifiedMergeNote(args: {
  workspace: WorkspaceRow;
  gateMessage: string;
  targetBranch: string;
  database: Database;
  recordMergeAttempt: RecordMergeAttempt;
}): Promise<void> {
  const { workspace, gateMessage, targetBranch, database, recordMergeAttempt } = args;
  try {
    const latest = await getLatestIssueCommentByKind(workspace.issueId, "merge-attempt", database);
    const latestPayload = latest?.payload ? (JSON.parse(latest.payload) as Record<string, unknown>) : null;
    if (latestPayload?.mergeReason === "merged_without_verification") return;
    await recordMergeAttempt(
      workspace,
      "warning",
      "Merging WITHOUT verification: this project has no verify_script and no smoke check, so no test "
      + `suite gated this merge. ${gateMessage}`,
      { mergeReason: "merged_without_verification", gateStage: "none", gateMessage, targetBranch },
    );
  } catch (err) {
    console.warn(
      "[workspace-merge] failed to record unverified-merge note (non-fatal):",
      errorMessage(err),
    );
  }
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
  // #276 — a DIRECT workspace's merge lands nothing. Its branch IS the default branch, and
  // `doMerge` short-circuits it to a plain close (handleWorkspaceMergeResolution →
  // "direct-closed"). But that short-circuit is evaluated inside the executor, i.e. AFTER
  // this gate, so closing a direct workspace used to pay a full verify run first — observed
  // on #232: a ~50-minute build+test that then timed out (`verify_script timed out after
  // 3000000ms`) to close a workspace that was never going to merge anything. There is no
  // diff to verify, so there is nothing here to gate.
  if (workspace.isDirect) {
    console.log(`[workspace-merge] skipping pre-lock gate for direct workspace ${workspaceId} — a direct merge lands nothing (#276)`);
    return token;
  }

  console.log(`[workspace-merge] pre-lock gate phase=start workspaceId=${workspaceId}`);
  // #540: the #243 pin-run-repin-mint protocol lives in ONE place now.
  // `baseBranch` matters: without it the gate cannot read the diff, so every diff-derived
  // cost decision silently degrades to its most expensive branch — the docs-only skip
  // (#198) could never fire on the merge path, and the test-package scoping cannot either.
  const gateWorkspace = { id: workspaceId, workingDir: workspace.workingDir, baseBranch };
  const preGate = await runGateWithEvidence({
    workspace: gateWorkspace,
    projectId,
    source: "pre-lock-merge",
    database,
  });

  if (!preGate.passed) {
    // #491 — before blaming this branch, check whether the base was ALREADY red at the
    // branch's merge-base. Best-effort: a failure here must never mask the real gate failure,
    // it can only ADD attribution to it.
    let gateMessage = preGate.message;
    if (workspace.workingDir) {
      try {
        const baseHealth = await getBaseBranchHealthAtMergeBase(
          projectId,
          workspace.workingDir,
          "HEAD",
          baseBranch,
          database,
        );
        const attribution = describeRedBaseAttribution(baseHealth);
        if (attribution) gateMessage = `${attribution}\n\n${preGate.message}`;
      } catch (err) {
        console.warn(
          "[workspace-merge] failed to resolve base-branch health attribution (non-fatal):",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    await recordGateFailureNote({
      workspace,
      stage: preGate.stage,
      gateMessage,
      targetBranch: baseBranch,
      database,
      recordMergeAttempt,
    });
    throw new WorkspaceError(
      `Pre-merge gate failed (${preGate.stage}) — merge withheld. ${gateMessage}`,
      "CONFLICT",
      { mergeReason: PRE_MERGE_GATE_FAILURE_REASON, gateStage: preGate.stage },
    );
  }

  if (preGate.unverified) {
    // Say it out loud on the timeline AND in the log. Deliberately not a block: plenty of projects
    // legitimately have nothing to gate on, and refusing their merges would be a worse defect than
    // the silence. What was missing was the SAYING (#377).
    console.warn(`[workspace-merge] merging workspace ${workspaceId} with NO verification configured for project ${projectId} (#377)`);
    await recordUnverifiedMergeNote({
      workspace,
      gateMessage: preGate.message,
      targetBranch: baseBranch,
      database,
      recordMergeAttempt,
    });
  }

  if (!preGate.ran) return token;

  console.log(
    `[workspace-merge] pre-lock gate passed workspaceId=${workspaceId} stage=${preGate.stage}; acquiring lock`,
  );
  // The minted evidence pins the exact state that was verified. That is what lets the in-lock
  // re-resolve accept the pass after an arbitrarily long lock wait (no pointless re-gate)
  // while still catching the case that genuinely invalidates it: another merge landed and
  // moved the base, so the merge RESULT is no longer what was tested.
  if (!preGate.token) {
    console.warn(
      `[workspace-merge] pre-lock gate passed for workspace ${workspaceId} but the ${preGate.moved} moved DURING the run ` +
        `— minting no evidence (#243); the merge executor will re-gate under the lock.`,
    );
    return token;
  }
  return preGate.token;
}

