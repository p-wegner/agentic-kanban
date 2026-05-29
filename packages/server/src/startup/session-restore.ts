import { db } from "../db/index.js";
import { sessions, workspaces } from "@agentic-kanban/shared/schema";
import { eq, inArray } from "drizzle-orm";
import { execFile } from "node:child_process";

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

/** Whether the workspace branch has commits its base branch lacks.
 * Mirrors hasCommittedChanges() in exit-workflow.ts: `git diff --quiet <base>`
 * exits non-zero when there is a diff, so a non-null err means "has changes".
 */
async function workspaceHasCommits(workingDir: string, baseBranch: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    execFile("git", ["diff", "--quiet", baseBranch], { cwd: workingDir }, (err: Error | null) => resolve(!!err));
  });
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
  const activeWs = await db.select({
    id: workspaces.id,
    workingDir: workspaces.workingDir,
    baseBranch: workspaces.baseBranch,
  })
    .from(workspaces)
    .where(inArray(workspaces.status, ["active", "reviewing", "fixing"]));
  const orphaned = activeWs.filter(ws => !runningWsIds.has(ws.id));
  if (orphaned.length > 0) {
    console.log(`[startup] ${orphaned.length} orphaned workspace(s) have no running session -- resolving status`);
    for (const ws of orphaned) {
      let newStatus = "idle";
      try {
        if (ws.workingDir && ws.baseBranch && (await workspaceHasCommits(ws.workingDir, ws.baseBranch))) {
          newStatus = "ready_for_merge";
        }
      } catch (err) {
        console.warn(`[startup] could not determine committed changes for orphaned workspace ${ws.id}`, err);
      }
      await db.update(workspaces).set({ status: newStatus, updatedAt: now }).where(eq(workspaces.id, ws.id));
      console.log(`[startup] orphaned workspace ${ws.id} -> ${newStatus}`);
    }
  }
}

/** Post-startup session state restoration: repopulate workflow Sets and sweep orphaned workspaces. */
export async function runSessionRestore(workflow: WorkflowSets): Promise<void> {
  await restoreWorkflowSets(workflow);
  await fixOrphanedWorkspaces();
}
