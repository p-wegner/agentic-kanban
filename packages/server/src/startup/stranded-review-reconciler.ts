import { issues, projectStatuses, sessions, workflowNodes, workspaceReviewPreflight, workspaces } from "@agentic-kanban/shared/schema";
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
import { resolveProjectReviewMode } from "../lib/review-mode-pref.js";
import { formatPostureNote } from "../services/risk-posture.service.js";

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

/**
 * Recover work stranded in "In Review" because the auto-review handshake never fired —
 * e.g. the in-process review/merge timers died on a server crash mid-flight, or the
 * review-launch threw and was swallowed (see exit-workflow.ts). Without this, a Builder
 * that finished and committed sits idle / readyForMerge=false / In Review forever and
 * `/merge` rejects it as "not_approved" (the tetris #1 incident, ticket #529).
 *
 * Finds workspaces that are idle, non-direct, in an "In Review" column, NOT yet
 * ready-for-merge, with committed changes ahead of base, NO running session, and NO
 * prior review session — then re-launches the review (via startManualReview, which
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
    if (!c.workingDir || !c.baseBranch) continue;
    // #998: a fork child (parentWorkspaceId set, or forkStatus stamped) is an ephemeral
    // sub-branch consolidated by its JOIN — never eligible for the stranded-review
    // reconciler, which would otherwise re-launch a review on it or mark it readyForMerge.
    if (c.parentWorkspaceId || c.forkStatus) continue;
    // #997: a workspace parked on a graph-owned workflow stage is owned by the graph — its own
    // node-driven stages decide review/fix, not this legacy reconciler. Skip it so a
    // mid-workflow branch never gets silently re-launched into review or marked readyForMerge.
    // #757 narrowed "graph-owned" to exclude a node MAPPED to the In Review status: nothing in
    // the graph launches a review for such a node, so skipping it here strands exactly the
    // workspace this reconciler exists to rescue. Same predicate as the exit engine's guard.
    if (graphOwnsPostExitReview(c.currentNodeId ? { nodeType: c.currentNodeType, statusName: c.currentNodeStatusName } : null)) continue;
    // A merge in flight OWNS this workspace (#270): its pre-lock gate runs for 20-40 minutes
    // with the workspace still idle, which is exactly the window in which this reconciler
    // used to launch a second review and strand the merge. The merge path runs/ran its own
    // gate — nothing here to recover.
    if (getMergeJob(c.wsId)?.state === "running") continue;
    // Another path (exit-workflow auto-review, manual review) is mid-launch — its session
    // row may not exist yet, so the running-session check below cannot see it (#270).
    if (isReviewLaunchPending(c.wsId)) continue;
    // Skip if a session is currently running for this workspace.
    const running = await database.select({ id: sessions.id }).from(sessions)
      .where(and(eq(sessions.workspaceId, c.wsId), eq(sessions.status, "running"))).limit(1);
    if (running.length > 0) continue;
    // Skip if a review already happened — don't re-review reviewed work.
    const priorReview = await database.select({ id: sessions.id }).from(sessions)
      .where(and(eq(sessions.workspaceId, c.wsId), eq(sessions.triggerType, "review"))).limit(1);
    if (priorReview.length > 0) continue;

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

    // #937 / decision 017: `sprint` posture (`reviewMode: "none"`) skips per-ticket review, so
    // this pass must NOT keep re-launching one — it is the safety net for exactly the state
    // "review will never come, mark it mergeable", and a posture that turned review off is
    // that state per PROJECT, the same way the global `auto_review=false` is board-wide.
    const reviewDecision = resolveProjectReviewMode(prefMap, c.projectId);
    const reviewThisOne = autoReview && reviewDecision.run;
    try {
      if (reviewThisOne) {
        const { sessionId } = await startManualReview(database, getSessionManager, boardEvents, reviewSessionIds, c.wsId, false);
        if (priorFailures > 0) await clearReviewPreflightBlock(database, c.wsId);
        console.log(`[reconcile] re-launched stranded review for workspace ${c.wsId} (#${c.issueNumber ?? "?"}) session=${sessionId}`);
      } else {
        await database.update(workspaces).set({ readyForMerge: true, updatedAt: new Date().toISOString() }).where(eq(workspaces.id, c.wsId));
        boardEvents.broadcast(c.projectId, "workspace_ready_for_merge");
        const why = autoReview
          ? `per-ticket review is off for this project${formatPostureNote(reviewDecision.posture)}`
          : "auto_review off";
        console.log(`[reconcile] ${why} — marked stranded workspace ${c.wsId} (#${c.issueNumber ?? "?"}) ready-for-merge`);
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

