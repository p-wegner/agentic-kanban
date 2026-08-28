import { issueComments, issues, projectStatuses, sessions, workflowNodes, workspaceReviewPreflight, workspaces } from "@agentic-kanban/shared/schema";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { AUTO_REVIEW_PREF_KEY, isAutoReviewEnabled } from "@agentic-kanban/shared/lib/auto-review-pref";
import { graphOwnsPostExitReview } from "./exit/workflow-ownership.js";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import type { BoardEventSink } from "../services/board-events.js";
import type { SessionLauncher } from "../services/session.manager.js";
import * as realGitService from "../services/git.service.js";
import type { GitService } from "../services/workspace-internals.js";
import { workspaceHasCommittedWork } from "../services/workspace-commits.js";
import { startManualReview, isReviewLaunchPending } from "../services/review.service.js";
import { getMergeJob } from "../services/merge-job.service.js";
import { recordDriveObstacle } from "../services/drive-obstacles.service.js";
import { PREF_RECONCILER_STRANDED_REVIEW_ENABLED } from "../constants/preference-keys.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { startPeriodicSweep, type PeriodicSweepHandle } from "../lib/periodic-sweep.js";
import { clearReviewPreflightBlockRow, setReviewPreflightBlock } from "../repositories/review-preflight.repository.js";

/**
 * How many times the reconciler may attempt a review preflight for the SAME pair of
 * branch/base tips before it gives up and reports a drive obstacle (#283).
 *
 * A rebase conflict is deterministic: the same two commits conflict every time until a
 * human or fix-and-merge changes something. Retrying it once a minute forever spawned the
 * most expensive git operation the board runs (one observed server run: 5 workspaces, 48
 * failures, 39 rebase attempts) and blocked the event loop each cycle. The budget is not 1
 * because a preflight can also fail transiently — an `index.lock` held by another process,
 * a fetch blip — and those deserve a retry.
 */
export const MAX_REVIEW_PREFLIGHT_ATTEMPTS = 3;

/** Marker signature used when the tips cannot be resolved, so the budget still applies. */
const UNKNOWN_SIGNATURE = "unknown";

/**
 * `<branchHeadSha>..<baseHeadSha>` — the identity of a preflight attempt. When it changes,
 * the conflict may genuinely have been resolved, so any existing block is void.
 */
async function computePreflightSignature(workingDir: string, baseBranch: string, gitService: GitService): Promise<string> {
  try {
    const [head, base] = await Promise.all([
      gitService.revParse(workingDir, "HEAD"),
      gitService.revParse(workingDir, baseBranch),
    ]);
    return `${head.trim()}..${base.trim()}`;
  } catch {
    return UNKNOWN_SIGNATURE;
  }
}

export interface StrandedReviewReconcilerDeps {
  database?: Database;
  getSessionManager: () => SessionLauncher;
  boardEvents: BoardEventSink;
  /** The SAME set the workflow engine uses, so a re-launched review's exit completes the chain. */
  reviewSessionIds: Set<string>;
  /**
   * Override enabled state for testing. When undefined (production path), the reconciler
   * reads the live `reconciler_stranded_review_enabled` preference from the DB at call time,
   * so a pref-level disable takes effect on the next tick with no restart.
   */
  enabled?: boolean;
  /**
   * Injected for testing — defaults to the real leading-OR-sibling probe. It lives behind a
   * dep rather than a module mock because the probe reaches the git-service SSOT in
   * `@agentic-kanban/shared`, which a `vi.mock("../services/git.service.js")` cannot see.
   */
  hasCommittedWork?: (
    workspace: { id: string; workingDir: string | null; baseBranch: string | null },
  ) => Promise<boolean>;
  /** Injectable git service (#558) — defaults to the real one. */
  gitService?: GitService;
}

/**
 * Drop any review-preflight backoff recorded for a workspace (#283). Called when the tips
 * move under a block, when a preflight finally succeeds, and by callers that materially
 * change the workspace (a new agent turn, an explicit rebase) and want the reconciler to
 * try again immediately.
 */
export async function clearReviewPreflightBlock(database: Database, workspaceId: string): Promise<void> {
  try {
    // #798: deleting the row IS the cleared state — the reads reconstruct `failures: 0`
    // with everything else null from a missing row, which is what the four columns held.
    await clearReviewPreflightBlockRow(workspaceId, database);
  } catch (err) {
    console.warn(`[reconcile] could not clear review-preflight block for ${workspaceId}:`, err instanceof Error ? err.message : err);
  }
}

/** The fields of a candidate row {@link isOwnedByAnotherPath} judges. */
interface ReconcilerCandidateOwnership {
  wsId: string;
  parentWorkspaceId: string | null;
  forkStatus: string | null;
  currentNodeId: string | null;
  currentNodeType: string | null;
  currentNodeStatusName: string | null;
}

/**
 * Is this candidate somebody ELSE's to move? A decision function (see the server CLAUDE.md's
 * named kinds): pure, synchronous, process-local, no query — which is exactly why it is
 * separable, and why the four unrelated ownership rules read as a list rather than as four
 * more branches inside the pass.
 */
function isOwnedByAnotherPath(c: ReconcilerCandidateOwnership): boolean {
  // #998: a fork child (parentWorkspaceId set, or forkStatus stamped) is an ephemeral
  // sub-branch consolidated by its JOIN — never eligible for the stranded-review
  // reconciler, which would otherwise re-launch a review on it or mark it readyForMerge.
  if (c.parentWorkspaceId || c.forkStatus) return true;
  // #997: a workspace parked on a graph-owned workflow stage is owned by the graph — its own
  // node-driven stages decide review/fix, not this legacy reconciler. Skip it so a
  // mid-workflow branch never gets silently re-launched into review or marked readyForMerge.
  // #757 narrowed "graph-owned" to exclude a node MAPPED to the In Review status: nothing in
  // the graph launches a review for such a node, so skipping it here strands exactly the
  // workspace this reconciler exists to rescue. Same predicate as the exit engine's guard.
  if (graphOwnsPostExitReview(c.currentNodeId ? { nodeType: c.currentNodeType, statusName: c.currentNodeStatusName } : null)) return true;
  // A merge in flight OWNS this workspace (#270): its pre-lock gate runs for 20-40 minutes
  // with the workspace still idle, which is exactly the window in which this reconciler
  // used to launch a second review and strand the merge. The merge path runs/ran its own
  // gate — nothing here to recover.
  if (getMergeJob(c.wsId)?.state === "running") return true;
  // Another path (exit-workflow auto-review, manual review) is mid-launch — its session
  // row may not exist yet, so the running-session check cannot see it (#270).
  return isReviewLaunchPending(c.wsId);
}

/**
 * Recover work stranded in "In Review" because the auto-review handshake never fired —
 * e.g. the in-process review/merge timers died on a server crash mid-flight, or the
 * review-launch threw and was swallowed (see exit-workflow.ts). Without this, a Builder
 * that finished and committed sits idle / readyForMerge=false / In Review forever and
 * `/merge` rejects it as "not_approved" (the tetris #1 incident, ticket #529).
 *
 * Two shapes of stranding, both reached from the same candidate scan:
 *
 *  1. **Never reviewed** — idle, non-direct, in an "In Review" column, NOT yet
 *     ready-for-merge, with committed changes ahead of base, NO running session, and NO
 *     prior review session. The review is (re-)launched.
 *  2. **Reviewed clean, never armed** (#932) — same, except a prior review session exited
 *     0, `readyForMerge` is still false, and NO merge has ever been attempted. The
 *     review-exit handler arms `readyForMerge` only after its own pre-merge gate returns,
 *     and that gate queues behind the build semaphore; while a long gate holds a slot, the
 *     arming never happens and the workspace is invisible to the monitor. Arm it rather
 *     than re-review it. The never-merge-attempted condition is load-bearing: a merge that
 *     hit a conflict clears the flag ON PURPOSE, and re-arming that would loop.
 *
 * For shape 1 this re-launches the review (via startManualReview, which
 * registers in the shared reviewSessionIds so the normal review → ready-for-merge →
 * auto-merge chain completes). If auto_review is off, marks them ready-for-merge so the
 * merge orchestrator can take them.
 *
 * Crash-safe and idempotent: runs on startup AND on an interval; startManualReview flips
 * the workspace to "reviewing", so the next pass skips it, and the prior-review guard
 * prevents re-reviewing already-reviewed work.
 */
export async function reconcileStrandedReviews(deps: StrandedReviewReconcilerDeps): Promise<number> {
  const database = deps.database ?? db;
  const { getSessionManager, boardEvents, reviewSessionIds } = deps;
  const gitService = deps.gitService ?? realGitService;

  // ONE short-TTL cached prefs scan per tick (#402) serves both the live enabled
  // check (so a pref-level disable still takes effect on the next tick, no restart)
  // and the prefMap below. A read failure keeps the previous fail-open behaviour.
  const prefRows = await getAllPreferencesCached(database).catch(() => null);
  const prefMap = new Map((prefRows ?? []).map((r) => [r.key, r.value]));
  const isEnabled = deps.enabled !== undefined
    ? deps.enabled
    : prefRows === null || prefMap.get(PREF_RECONCILER_STRANDED_REVIEW_ENABLED) !== "false";
  if (!isEnabled) {
    console.log("[reconcile] stranded-review reconciler disabled via preference — skipping tick");
    return 0;
  }

  const autoReview = isAutoReviewEnabled(prefMap.get(AUTO_REVIEW_PREF_KEY));
  const hasCommittedWork = deps.hasCommittedWork
    ?? ((ws) => workspaceHasCommittedWork({ ...ws, isDirect: false }, null, database, { onUnknown: false }));

  const candidates = await database
    .select({
      wsId: workspaces.id,
      workingDir: workspaces.workingDir,
      baseBranch: workspaces.baseBranch,
      issueNumber: issues.issueNumber,
      projectId: issues.projectId,
      currentNodeId: workspaces.currentNodeId,
      currentNodeType: workflowNodes.nodeType,
      currentNodeStatusName: workflowNodes.statusName,
      parentWorkspaceId: workspaces.parentWorkspaceId,
      forkStatus: workspaces.forkStatus,
      // #798: the backoff moved off the row into `workspace_review_preflight`. LEFT JOIN,
      // so a workspace with no block still appears as a candidate with `null` failures —
      // exactly the shape the all-defaults columns used to produce.
      preflightFailures: workspaceReviewPreflight.failures,
      preflightSignature: workspaceReviewPreflight.signature,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .leftJoin(workflowNodes, eq(workspaces.currentNodeId, workflowNodes.id))
    .leftJoin(workspaceReviewPreflight, eq(workspaceReviewPreflight.workspaceId, workspaces.id))
    .where(and(
      eq(workspaces.status, "idle"),
      eq(workspaces.isDirect, false),
      eq(workspaces.readyForMerge, false),
      eq(projectStatuses.name, "In Review"),
    ));

  let recovered = 0;
  let blocked = 0;
  for (const c of candidates) {
    // Kept inline (not folded into `isOwnedByAnotherPath`) so the compiler narrows both to
    // non-null for the rest of the loop body. Nothing to reason about without a worktree and
    // a base to diff it against.
    if (!c.workingDir || !c.baseBranch) continue;
    if (isOwnedByAnotherPath(c)) continue;
    // Skip if a session is currently running for this workspace.
    const running = await database.select({ id: sessions.id }).from(sessions)
      .where(and(eq(sessions.workspaceId, c.wsId), eq(sessions.status, "running"))).limit(1);
    if (running.length > 0) continue;
    // A review already happened — don't re-review reviewed work. But "reviewed" and
    // "ready to merge" had drifted apart with nothing to reconcile them (#932): the
    // review-exit handler arms `readyForMerge` only AFTER its own pre-merge gate returns,
    // and that gate queues behind the build semaphore. While one long gate holds a slot
    // (observed: 47 minutes), a review that exited CLEAN sits here un-armed — invisible to
    // the monitor (idle + not ready) and skipped by this pass forever, because the guard
    // below only asked WHETHER a review ran, never how it ended. It needed a manual
    // `POST /:id/ready-for-merge` to move at all.
    //
    // So: a CLEAN prior review (exit 0) on a workspace still not ready is not "already
    // handled", it is the stranding this pass exists to undo — arm it below instead of
    // skipping. A review that exited NON-ZERO genuinely wants a human/fix, and a review
    // still in flight is caught by the running-session check above, so neither is armed.
    const priorReviews = await database.select({ id: sessions.id, exitCode: sessions.exitCode, status: sessions.status }).from(sessions)
      .where(and(eq(sessions.workspaceId, c.wsId), eq(sessions.triggerType, "review")));
    let armAfterCleanReview = false;
    if (priorReviews.length > 0) {
      const cleanReview = priorReviews.some((r) => r.status !== "running" && r.exitCode === "0");
      if (!cleanReview) continue;
      // `readyForMerge: false` after a CLEAN review has two causes, and only one of them is
      // the #932 stranding. The other is a merge that was ATTEMPTED and deliberately
      // un-armed the flag: `recordConflictAndClearReadyFlag` on a real conflict,
      // `keepCleanAncestorInReview` on the 0-commit ancestor guard, and the fix-and-merge
      // exit's #764 "did not land" path all clear it precisely so a conflicted branch is
      // NOT silently re-queued as ready. Re-arming those would undo the guard and loop:
      // arm → auto-merge → conflict → clear → arm again, once every 60s tick, forever.
      //
      // Every one of those paths runs only AFTER a merge attempt, and every merge attempt
      // writes a `merge-attempt` comment for the workspace. So "no merge-attempt row" is
      // the precise test for "nothing has ever cleared this flag" — which is exactly the
      // shape #932 describes (a review that finished while a gate held the semaphore, with
      // no merge yet tried). Conservative by construction: an un-armed workspace we cannot
      // prove was never merge-attempted is left for the human, not auto-approved.
      const mergeAttempt = await database.select({ id: issueComments.id }).from(issueComments)
        .where(and(eq(issueComments.workspaceId, c.wsId), eq(issueComments.kind, "merge-attempt"))).limit(1);
      if (mergeAttempt.length > 0) continue;
      armAfterCleanReview = true;
    }

    // #283 — a preflight that already failed its budget for THESE tips is not retried.
    // Checked before the (more expensive) ahead-count so a blocked workspace costs two
    // rev-parses per cycle instead of a full rebase. Candidates that have never failed
    // skip the signature computation entirely and resolve it lazily on failure.
    let signature: string | null = null;
    const priorFailures = c.preflightFailures ?? 0;
    if (priorFailures > 0) {
      signature = await computePreflightSignature(c.workingDir, c.baseBranch, gitService);
      if (c.preflightSignature && c.preflightSignature !== signature) {
        // Either tip moved — the conflict may be resolved, so the block is void.
        await clearReviewPreflightBlock(database, c.wsId);
        console.log(`[reconcile] workspace ${c.wsId} (#${c.issueNumber ?? "?"}) has new commits — clearing review-preflight block`);
      } else if (priorFailures >= MAX_REVIEW_PREFLIGHT_ATTEMPTS) {
        blocked++;
        continue;
      }
    }

    // Require committed changes ahead of base (don't review an empty branch). #539: this
    // is the leading-OR-sibling probe, because a sibling-only ticket (#69) commits nothing
    // in the leading worktree — the old leading-only count read it as an empty branch and
    // left it stranded, which is the exact state this pass exists to recover.
    // `onUnknown: false`: `true` here is what makes the pass ACT (launch a review, or mark
    // ready-for-merge), so a git failure must not start it acting on no evidence.
    const hasWork = await hasCommittedWork({ id: c.wsId, workingDir: c.workingDir, baseBranch: c.baseBranch })
      .catch(() => false);
    if (!hasWork) continue;

    try {
      if (armAfterCleanReview) {
        // #932: the review already ran and passed; what never happened is the arming.
        // Re-reviewing would burn a second session to reach the same verdict, so this
        // completes the handshake instead.
        //
        // This arms readyForMerge WITHOUT writing gate evidence, deliberately — the gate
        // never finished for this workspace, so there is nothing honest to record. The
        // merge path is unaffected either way: with no `workspace_merge_gate` row,
        // `gateTokenFromWorkspaceEvidence` returns `RUN_GATE`; with a stale row from an
        // earlier run, `evidenceIsValid` rejects it on a moved tip or on age. So the merge
        // still gates, and `readyForMerge` goes back to meaning "reviewed and approved"
        // rather than "and the gate also happened to get a semaphore slot in time".
        await database.update(workspaces).set({ readyForMerge: true, updatedAt: new Date().toISOString() }).where(eq(workspaces.id, c.wsId));
        boardEvents.broadcast(c.projectId, "workspace_ready_for_merge");
        console.log(`[reconcile] review of workspace ${c.wsId} (#${c.issueNumber ?? "?"}) exited clean but readyForMerge was never armed — arming it (#932)`);
      } else if (autoReview) {
        const { sessionId } = await startManualReview(database, getSessionManager, boardEvents, reviewSessionIds, c.wsId, false);
        if (priorFailures > 0) await clearReviewPreflightBlock(database, c.wsId);
        console.log(`[reconcile] re-launched stranded review for workspace ${c.wsId} (#${c.issueNumber ?? "?"}) session=${sessionId}`);
      } else {
        await database.update(workspaces).set({ readyForMerge: true, updatedAt: new Date().toISOString() }).where(eq(workspaces.id, c.wsId));
        boardEvents.broadcast(c.projectId, "workspace_ready_for_merge");
        console.log(`[reconcile] auto_review off — marked stranded workspace ${c.wsId} (#${c.issueNumber ?? "?"}) ready-for-merge`);
      }
      recovered++;
    } catch (err) {
      const message = errorMessage(err);
      console.warn(`[reconcile] failed to recover stranded workspace ${c.wsId}:`, message);
      // #283 — remember the failure so the next cycle does not repeat it blindly.
      signature ??= await computePreflightSignature(c.workingDir, c.baseBranch, gitService);
      const failures = (c.preflightSignature === signature ? priorFailures : 0) + 1;
      const exhausted = failures >= MAX_REVIEW_PREFLIGHT_ATTEMPTS;
      // The old inline write also bumped `workspaces.updatedAt` because it was one `set({...})`.
      // Kept as a separate statement rather than dropped: nothing in this repo asserts it, but
      // `updatedAt` is read as an activity signal elsewhere, and an extraction is the wrong
      // place to change what the board believes about a workspace's last activity.
      await database.update(workspaces).set({ updatedAt: new Date().toISOString() })
        .where(eq(workspaces.id, c.wsId)).catch(() => {});
      await setReviewPreflightBlock(c.wsId, {
        failures,
        error: message.slice(0, 2000),
        signature,
        blockedAt: exhausted ? new Date().toISOString() : null,
      }, database).catch((writeErr) => {
        console.warn(`[reconcile] could not persist review-preflight failure for ${c.wsId}:`, writeErr instanceof Error ? writeErr.message : writeErr);
      });
      if (exhausted) {
        blocked++;
        console.warn(
          `[reconcile] giving up on stranded workspace ${c.wsId} (#${c.issueNumber ?? "?"}) after ${failures} failed review preflights for the same commits — route to fix-and-merge`,
        );
        await recordDriveObstacle({
          projectId: c.projectId,
          kind: "review_preflight_conflict",
          severity: "warning",
          issueNumber: c.issueNumber ?? null,
          summary: `Review preflight failed ${failures}x for workspace ${c.wsId}; retries stopped until the branch or base moves`,
          details: { workspaceId: c.wsId, signature, error: message.slice(0, 2000) },
        }, { database, broadcast: (projectId, reason) => boardEvents.broadcast(projectId, reason) });
      }
    }
  }
  if (recovered > 0) console.log(`[reconcile] recovered ${recovered} stranded In-Review workspace(s)`);
  if (blocked > 0) console.log(`[reconcile] ${blocked} stranded workspace(s) blocked on an unresolvable review preflight — not retried`);
  return recovered;
}

const DEFAULT_INTERVAL_MS = 60_000;

let activeStrandedReviewSweep: PeriodicSweepHandle | null = null;

export function stopStrandedReviewReconciler(): void {
  activeStrandedReviewSweep?.stop();
  activeStrandedReviewSweep = null;
}

/** Run the reconciler shortly after boot (crash recovery) and then on an interval. */
export function startStrandedReviewReconciler(deps: StrandedReviewReconcilerDeps, intervalMs = DEFAULT_INTERVAL_MS): PeriodicSweepHandle {
  stopStrandedReviewReconciler();
  activeStrandedReviewSweep = startPeriodicSweep({
    name: "reconcile",
    tick: () => reconcileStrandedReviews(deps),
    bootDelayMs: 25_000,
    intervalMs,
  });
  return activeStrandedReviewSweep;
}

