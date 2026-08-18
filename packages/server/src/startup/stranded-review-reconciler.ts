import { issues, projectStatuses, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { AUTO_REVIEW_PREF_KEY, isAutoReviewEnabled } from "@agentic-kanban/shared/lib/auto-review-pref";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import type { BoardEvents } from "../services/board-events.js";
import type { SessionManager } from "../services/session.manager.js";
import { revParse } from "../services/git.service.js";
import { workspaceHasCommittedWork } from "../services/workspace-commits.js";
import { startManualReview, isReviewLaunchPending } from "../services/review.service.js";
import { getMergeJob } from "../services/merge-job.service.js";
import { recordDriveObstacle } from "../services/drive-obstacles.service.js";
import { PREF_RECONCILER_STRANDED_REVIEW_ENABLED } from "../constants/preference-keys.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { startPeriodicSweep, type PeriodicSweepHandle } from "../lib/periodic-sweep.js";

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
async function computePreflightSignature(workingDir: string, baseBranch: string): Promise<string> {
  try {
    const [head, base] = await Promise.all([
      revParse(workingDir, "HEAD"),
      revParse(workingDir, baseBranch),
    ]);
    return `${head.trim()}..${base.trim()}`;
  } catch {
    return UNKNOWN_SIGNATURE;
  }
}

export interface StrandedReviewReconcilerDeps {
  database?: Database;
  getSessionManager: () => SessionManager;
  boardEvents: BoardEvents;
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
}

/**
 * Drop any review-preflight backoff recorded for a workspace (#283). Called when the tips
 * move under a block, when a preflight finally succeeds, and by callers that materially
 * change the workspace (a new agent turn, an explicit rebase) and want the reconciler to
 * try again immediately.
 */
export async function clearReviewPreflightBlock(database: Database, workspaceId: string): Promise<void> {
  try {
    await database.update(workspaces).set({
      reviewPreflightFailures: 0,
      reviewPreflightError: null,
      reviewPreflightSignature: null,
      reviewPreflightBlockedAt: null,
    }).where(eq(workspaces.id, workspaceId));
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
      preflightFailures: workspaces.reviewPreflightFailures,
      preflightSignature: workspaces.reviewPreflightSignature,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
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
      signature = await computePreflightSignature(c.workingDir, c.baseBranch);
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
      if (autoReview) {
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
      signature ??= await computePreflightSignature(c.workingDir, c.baseBranch);
      const failures = (c.preflightSignature === signature ? priorFailures : 0) + 1;
      const exhausted = failures >= MAX_REVIEW_PREFLIGHT_ATTEMPTS;
      await database.update(workspaces).set({
        reviewPreflightFailures: failures,
        reviewPreflightError: message.slice(0, 2000),
        reviewPreflightSignature: signature,
        reviewPreflightBlockedAt: exhausted ? new Date().toISOString() : null,
        updatedAt: new Date().toISOString(),
      }).where(eq(workspaces.id, c.wsId)).catch((writeErr) => {
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

