import { issues, projectStatuses, workspaces } from "@agentic-kanban/shared/schema";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { MonitorActionName } from "../services/monitor-nudge.js";
import type { MonitorAction } from "./monitor-helpers.js";
import type { WorkspaceCandidate } from "./monitor-cycle.js";

export type LogMonitorActionFn = (action: MonitorActionName, workspaceId: string, issueId: string, extra?: Pick<MonitorAction, "endpoint" | "httpStatus" | "responseSummary" | "verificationResult">) => void;

/** Looks up a project status id by name. Issues exactly ONE db.select per invocation. */
export async function getProjectStatusIdByName(projectId: string, name: string): Promise<string | undefined> {
  const rows = await db.select({ id: projectStatuses.id }).from(projectStatuses)
    .where(sql`${projectStatuses.name} = ${name} AND ${projectStatuses.projectId} = ${projectId}`).limit(1);
  return rows[0]?.id;
}

/**
 * Triggers a merge for the workspace; on a non-ok response or network failure,
 * falls back to fix-and-merge with the merge error. The caller keeps ownership
 * of `stats.merged++` (a failed merge that fell back still consumes a merge
 * slot, by design) and of broadcasting the board change.
 */
export async function mergeWorkspaceWithFixFallback(
  ws: WorkspaceCandidate,
  serverPort: number,
  logAction: LogMonitorActionFn,
  logs: { conflictMsg: string; successMsg: string },
): Promise<void> {
  const mergeEndpoint = `/api/workspaces/${ws.wsId}/merge`;
  const mergeRes = await fetch(`http://127.0.0.1:${serverPort}${mergeEndpoint}`, { method: "POST" }).catch(() => null);
  if (!mergeRes || !mergeRes.ok) {
    const body = mergeRes ? await mergeRes.json().catch(() => ({})) : {};
    const mergeError = (body as Record<string, string>)?.message || "merge failed";
    const fixEndpoint = `/api/workspaces/${ws.wsId}/fix-and-merge`;
    const fixRes = await fetch(`http://127.0.0.1:${serverPort}${fixEndpoint}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mergeError }),
    }).catch(() => null);
    console.log(logs.conflictMsg);
    logAction("merge", ws.wsId, ws.issueId, {
      endpoint: fixEndpoint,
      httpStatus: fixRes?.status,
      responseSummary: mergeError.slice(0, 200),
      verificationResult: fixRes?.ok ? "ok" : "failed",
    });
  } else {
    console.log(logs.successMsg);
    logAction("merge", ws.wsId, ws.issueId, {
      endpoint: mergeEndpoint,
      httpStatus: mergeRes.status,
      verificationResult: "ok",
    });
  }
}

/**
 * Closes a direct workspace and moves its issue to Done. The caller keeps the
 * status-specific console.log and the board broadcast at the call site.
 */
export async function closeDirectWorkspaceAsDone(ws: WorkspaceCandidate, logAction: LogMonitorActionFn): Promise<void> {
  const now = new Date().toISOString();
  await db.update(workspaces).set({ status: "closed", workingDir: null, updatedAt: now }).where(eq(workspaces.id, ws.wsId)).catch(() => {});
  const doneStatusId = await getProjectStatusIdByName(ws.projectId, "Done");
  if (doneStatusId) await db.update(issues).set({ statusId: doneStatusId, updatedAt: now }).where(eq(issues.id, ws.issueId)).catch(() => {});
  logAction("merge", ws.wsId, ws.issueId, { verificationResult: "ok" });
}
