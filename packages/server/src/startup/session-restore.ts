import { db } from "../db/index.js";
import { sessions, workspaces } from "@agentic-kanban/shared/schema";
import { eq, inArray } from "drizzle-orm";

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
    } else if (s.triggerType === "fix-and-merge") {
      fixAndMergeSessionIds.add(s.id);
      console.log(`[startup] restored fix-and-merge session: sessionId=${s.id}`);
    } else if (s.triggerType === "learning") {
      learningSessionIds.add(s.id);
      console.log(`[startup] restored learning session: sessionId=${s.id}`);
    }
  }
}

/** Reset workspaces stuck in active/reviewing/fixing with no running session.
 *
 * This happens when the server crashes between session completion and the
 * workspace status update. On the next restart these workspaces would appear
 * permanently busy with no agent actually running.
 */
async function fixOrphanedWorkspaces(): Promise<void> {
  const now = new Date().toISOString();
  const runningWsIds = new Set(
    (await db.select({ workspaceId: sessions.workspaceId })
      .from(sessions)
      .where(eq(sessions.status, "running")))
      .map(r => r.workspaceId),
  );
  const activeWs = await db.select({ id: workspaces.id })
    .from(workspaces)
    .where(inArray(workspaces.status, ["active", "reviewing", "fixing"]));
  const orphanedIds = activeWs.filter(ws => !runningWsIds.has(ws.id)).map(ws => ws.id);
  if (orphanedIds.length > 0) {
    console.log(`[startup] ${orphanedIds.length} orphaned workspace(s) have no running session — resetting to idle`);
    for (const wsId of orphanedIds) {
      await db.update(workspaces).set({ status: "idle", updatedAt: now }).where(eq(workspaces.id, wsId));
    }
  }
}

/** Post-startup session state restoration: repopulate workflow Sets and sweep orphaned workspaces. */
export async function runSessionRestore(workflow: WorkflowSets): Promise<void> {
  await restoreWorkflowSets(workflow);
  await fixOrphanedWorkspaces();
}
