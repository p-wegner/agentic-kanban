import { issues, preferences, projectStatuses, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import type { BoardEvents } from "../services/board-events.js";
import type { SessionManager } from "../services/session.manager.js";
import { getCommitCountAhead } from "../services/git.service.js";
import { startManualReview } from "../services/review.service.js";

export interface StrandedReviewReconcilerDeps {
  database?: Database;
  getSessionManager: () => SessionManager;
  boardEvents: BoardEvents;
  /** The SAME set the workflow engine uses, so a re-launched review's exit completes the chain. */
  reviewSessionIds: Set<string>;
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

  const prefRows = await database.select({ key: preferences.key, value: preferences.value }).from(preferences);
  const prefMap = new Map(prefRows.map((r) => [r.key, r.value]));
  const autoReview = prefMap.get("auto_review") !== "false";

  const candidates = await database
    .select({
      wsId: workspaces.id,
      workingDir: workspaces.workingDir,
      baseBranch: workspaces.baseBranch,
      issueNumber: issues.issueNumber,
      projectId: issues.projectId,
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
  for (const c of candidates) {
    if (!c.workingDir || !c.baseBranch) continue;
    // Skip if a session is currently running for this workspace.
    const running = await database.select({ id: sessions.id }).from(sessions)
      .where(and(eq(sessions.workspaceId, c.wsId), eq(sessions.status, "running"))).limit(1);
    if (running.length > 0) continue;
    // Skip if a review already happened — don't re-review reviewed work.
    const priorReview = await database.select({ id: sessions.id }).from(sessions)
      .where(and(eq(sessions.workspaceId, c.wsId), eq(sessions.triggerType, "review"))).limit(1);
    if (priorReview.length > 0) continue;
    // Require committed changes ahead of base (don't review an empty branch).
    const ahead = await getCommitCountAhead(c.workingDir, c.baseBranch).catch(() => 0);
    if (!ahead || ahead <= 0) continue;

    try {
      if (autoReview) {
        const { sessionId } = await startManualReview(database, getSessionManager, boardEvents, reviewSessionIds, c.wsId, false);
        console.log(`[reconcile] re-launched stranded review for workspace ${c.wsId} (#${c.issueNumber ?? "?"}) session=${sessionId}`);
      } else {
        await database.update(workspaces).set({ readyForMerge: true, updatedAt: new Date().toISOString() }).where(eq(workspaces.id, c.wsId));
        boardEvents.broadcast(c.projectId, "workspace_ready_for_merge");
        console.log(`[reconcile] auto_review off — marked stranded workspace ${c.wsId} (#${c.issueNumber ?? "?"}) ready-for-merge`);
      }
      recovered++;
    } catch (err) {
      console.warn(`[reconcile] failed to recover stranded workspace ${c.wsId}:`, err instanceof Error ? err.message : err);
    }
  }
  if (recovered > 0) console.log(`[reconcile] recovered ${recovered} stranded In-Review workspace(s)`);
  return recovered;
}

const DEFAULT_INTERVAL_MS = 60_000;

/** Run the reconciler shortly after boot (crash recovery) and then on an interval. */
export function startStrandedReviewReconciler(deps: StrandedReviewReconcilerDeps, intervalMs = DEFAULT_INTERVAL_MS): ReturnType<typeof setInterval> {
  const tick = () => {
    reconcileStrandedReviews(deps).catch((err) => console.warn("[reconcile] cycle error:", err instanceof Error ? err.message : err));
  };
  setTimeout(tick, 25_000);
  return setInterval(tick, intervalMs);
}
