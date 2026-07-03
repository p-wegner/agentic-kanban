import { transitionIssueStatus } from "@agentic-kanban/shared/lib/workflow-engine";
import { projectStatuses } from "@agentic-kanban/shared/schema";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { setWorkspaceStatus } from "../repositories/workspace-status.repository.js";
import type { MonitorActionName } from "../services/monitor-nudge.js";
import type { MonitorAction } from "./monitor-helpers.js";
import type { WorkspaceCandidate } from "./monitor-cycle.js";
import type { MonitorWorkspaceActions } from "./monitor-workspace-actions.js";

export type LogMonitorActionFn = (action: MonitorActionName, workspaceId: string, issueId: string, extra?: Pick<MonitorAction, "endpoint" | "httpStatus" | "responseSummary" | "verificationResult">) => void;

/** Looks up a project status id by name. Issues exactly ONE db.select per invocation. */
export async function getProjectStatusIdByName(projectId: string, name: string): Promise<string | undefined> {
  const rows = await db.select({ id: projectStatuses.id }).from(projectStatuses)
    .where(sql`${projectStatuses.name} = ${name} AND ${projectStatuses.projectId} = ${projectId}`).limit(1);
  return rows[0]?.id;
}

/**
 * Triggers a merge for the workspace; on failure (conflict, lock, etc.) falls
 * back to fix-and-merge with the merge error. Calls the workspace application
 * service DIRECTLY via the injected port — NOT over self-HTTP. A rejected merge
 * promise maps 1:1 to the old non-2xx/network-failure branch, so the fix-and-merge
 * fallback fires under exactly the same conditions. The caller keeps ownership of
 * `stats.merged++` (a failed merge that fell back still consumes a merge slot, by
 * design) and of broadcasting the board change.
 */
export async function mergeWorkspaceWithFixFallback(
  ws: WorkspaceCandidate,
  workspaceActions: MonitorWorkspaceActions,
  logAction: LogMonitorActionFn,
  logs: { conflictMsg: string; successMsg: string },
): Promise<void> {
  try {
    await workspaceActions.merge(ws.wsId);
    console.log(logs.successMsg);
    logAction("merge", ws.wsId, ws.issueId, {
      endpoint: `POST /api/workspaces/${ws.wsId}/merge`,
      verificationResult: "ok",
    });
  } catch (err) {
    const mergeError = err instanceof Error ? err.message : "merge failed";
    let fixOk = true;
    try {
      await workspaceActions.fixAndMerge(ws.wsId, mergeError);
    } catch {
      fixOk = false;
    }
    console.log(logs.conflictMsg);
    logAction("merge", ws.wsId, ws.issueId, {
      endpoint: `POST /api/workspaces/${ws.wsId}/fix-and-merge`,
      responseSummary: mergeError.slice(0, 200),
      verificationResult: fixOk ? "ok" : "failed",
    });
  }
}

/**
 * Closes a direct workspace and moves its issue to Done. The caller keeps the
 * status-specific console.log and the board broadcast at the call site.
 */
export async function closeDirectWorkspaceAsDone(ws: WorkspaceCandidate, logAction: LogMonitorActionFn): Promise<void> {
  const now = new Date().toISOString();
  await setWorkspaceStatus(db, ws.wsId, "closed", { now, set: { workingDir: null } });
  const doneStatusId = await getProjectStatusIdByName(ws.projectId, "Done");
  if (doneStatusId) await transitionIssueStatus(db, ws.issueId, doneStatusId, { now }).catch((err) => console.warn(`[monitor] failed to move direct-workspace issue ${ws.issueId} to Done:`, err instanceof Error ? err.message : String(err)));
  logAction("merge", ws.wsId, ws.issueId, { verificationResult: "ok" });
}
