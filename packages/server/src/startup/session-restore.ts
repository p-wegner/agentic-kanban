import { db } from "../db/index.js";
import { sessions, workspaces } from "@agentic-kanban/shared/schema";
import { eq, inArray } from "drizzle-orm";
import { setWorkspaceStatus, type WorkspaceStatus } from "../repositories/workspace-status.repository.js";
import { hasCommitsAhead } from "./branch-commits.js";

interface WorkflowSets {
  reviewSessionIds: Set<string>;
  fixAndMergeSessionIds: Set<string>;
  learningSessionIds: Set<string>;
}

/** Restore in-memory workflow tracking Sets from DB after server restart.
 *
 * When the server restarts, reviewSessionIds / fixAndMergeSessionIds /
 * learningSessionIds are empty. If a review or fix-and-merge session is still
 * running, runWorkflowOnExit won't recognise it and won't trigger auto-merge or
 * the fix-and-merge retry. This function re-populates the Sets from any
 * sessions still marked "running" in the DB.
 */
async function restoreWorkflowSets({ reviewSessionIds, fixAndMergeSessionIds, learningSessionIds }: WorkflowSets): Promise<void> {
  const runningSessions = await db.select({
    id: sessions.id,
    triggerType: sessions.triggerType,
  }).from(sessions).where(eq(sessions.status, "running"));

  for (const s of runningSessions) {
    if (s.triggerType === "review") {
      reviewSessionIds.add(s.id);
      console.log(`[startup] restored review session: sessionId=${s.id}`);
    } else if (s.triggerType === "fix-and-merge" || s.triggerType === "fix-conflicts") {
      // "fix-conflicts" (resolve-conflicts route) sessions live in the same
      // fixAndMergeSessionIds set as fix-and-merge sessions at launch time —
      // restore them into the same set (see roleFromTriggerType, #950).
      fixAndMergeSessionIds.add(s.id);
      console.log(`[startup] restored ${s.triggerType} session: sessionId=${s.id}`);
    } else if (s.triggerType === "learning") {
      learningSessionIds.add(s.id);
      console.log(`[startup] restored learning session: sessionId=${s.id}`);
    }
  }
}

/** Reset workspaces stuck in active/reviewing/fixing with no running session.
 *
 * This happens when the server crashes between session completion and the
 * workspace status update, OR when an agent process died while the server was
 * down. On the next restart these workspaces would appear permanently busy with
 * no agent actually running.
 *
 * This runs AFTER cleanupStaleSessions, which already reattaches every surviving
 * agent (its session row stays status="running") and stops every confirmed-dead
 * session. So any workspace reaching here with no running session is genuinely
 * orphaned. Rather than blindly forcing "idle" -- which would discard work an
 * agent committed before the server went down -- mirror the normal session-exit
 * decision (see hasCommittedChanges in exit-workflow.ts): if the branch is ahead
 * of its base, mark "ready_for_merge"; otherwise "idle". The sweep is already
 * scoped to active/reviewing/fixing, so a workspace already in ready_for_merge /
 * awaiting-plan-approval is never touched.
 */
async function fixOrphanedWorkspaces(): Promise<void> {
  const now = new Date().toISOString();
  const runningWsIds = new Set(
    (await db.select({ workspaceId: sessions.workspaceId })
      .from(sessions)
      .where(eq(sessions.status, "running")))
      .map(r => r.workspaceId),
  );
  // #574: workingDir/baseBranch were only read to decide ready_for_merge vs idle; that
  // branch is gone, so the query no longer needs them.
  const activeWs = await db.select({ id: workspaces.id })
    .from(workspaces)
    .where(inArray(workspaces.status, ["active", "reviewing", "fixing"]));
  const orphaned = activeWs.filter(ws => !runningWsIds.has(ws.id));
  if (orphaned.length > 0) {
    console.log(`[startup] ${orphaned.length} orphaned workspace(s) have no running session -- resolving status`);
    for (const ws of orphaned) {
      // #574: this used to resolve to "ready_for_merge" when commits existed — a status
      // NO automated path processes. `processCandidate` (monitor-cycle) branches on
      // idle/reviewing/blocked/active, the auto-merge orchestrator requires idle, and the
      // stranded-review reconciler requires idle. So an orphaned workspace WITH commits —
      // i.e. one that had done real work — was strictly worse off than one without: it
      // sat invisible until a human touched it.
      //
      // `idle` matches what the RUNTIME path (completion-state-reconciler) resolves the
      // same situation to, so a restart no longer produces a state the running system
      // never would. The monitor then reviews/merges it normally.
      const newStatus: WorkspaceStatus = "idle";
      await setWorkspaceStatus(db, ws.id, newStatus, { now });
      console.log(`[startup] orphaned workspace ${ws.id} -> ${newStatus}`);
    }
  }
}

/** Post-startup session state restoration: repopulate workflow Sets and sweep orphaned workspaces. */
export async function runSessionRestore(workflow: WorkflowSets): Promise<void> {
  await restoreWorkflowSets(workflow);
  await fixOrphanedWorkspaces();
}
