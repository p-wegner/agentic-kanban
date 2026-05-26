import { issues, projectStatuses, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { createBoardEvents } from "../services/board-events.js";
import { sendMonitorNudge, type MonitorActionName } from "../services/monitor-nudge.js";
import type { createSessionManager } from "../services/session.manager.js";
import type { MonitorAction } from "./monitor-helpers.js";

const MAX_SESSIONS = 10;

export interface WorkspaceCandidate {
  wsId: string;
  wsStatus: string;
  workingDir: string | null;
  isDirect: boolean;
  projectId: string;
  issueId: string;
  issueTitle: string;
  issueNumber: number | null;
  issueStatusName: string;
  baseBranch: string | null;
}

export interface ProcessWorkspaceDeps {
  sessionManager: ReturnType<typeof createSessionManager>;
  boardEvents: ReturnType<typeof createBoardEvents>;
  serverPort: number;
  monitorRecentActions: MonitorAction[];
  logMonitorAction: (recentActions: MonitorAction[], action: MonitorActionName, workspaceId: string, issueId: string) => void;
  buildMonitorNudgePrompt: (projectId: string) => Promise<string>;
  getRecentAgentExcerpts: (sessionId: string, count?: number) => Promise<string[]>;
  shouldSkipNudge: (excerpts: string[]) => boolean;
}

export async function processWorkspaceCandidates(candidates: WorkspaceCandidate[], deps: ProcessWorkspaceDeps): Promise<{ relaunched: number; merged: number; nudged: number }> {
  const stats = { relaunched: 0, merged: 0, nudged: 0 };
  const logAction = (action: MonitorActionName, workspaceId: string, issueId: string) => deps.logMonitorAction(deps.monitorRecentActions, action, workspaceId, issueId);
  for (const ws of candidates) {
    try {
      const [sess] = await db.select({ id: sessions.id, status: sessions.status, startedAt: sessions.startedAt }).from(sessions)
        .where(eq(sessions.workspaceId, ws.wsId)).orderBy(desc(sessions.startedAt)).limit(1);
      const sessionCountRows = await db.select({ count: sql<number>`count(*)` }).from(sessions).where(eq(sessions.workspaceId, ws.wsId));
      const sessionCount = Number(sessionCountRows[0]?.count ?? 0);

      if (ws.wsStatus === "idle") {
        if (ws.isDirect) {
          const now = new Date().toISOString();
          await db.update(workspaces).set({ status: "closed", workingDir: null, updatedAt: now }).where(eq(workspaces.id, ws.wsId)).catch(() => {});
          const doneStatusRow = await db.select({ id: projectStatuses.id }).from(projectStatuses).where(sql`${projectStatuses.name} = 'Done' AND ${projectStatuses.projectId} = ${ws.projectId}`).limit(1);
          if (doneStatusRow.length > 0) await db.update(issues).set({ statusId: doneStatusRow[0].id, updatedAt: now }).where(eq(issues.id, ws.issueId)).catch(() => {});
          logAction("merge", ws.wsId, ws.issueId);
          console.log(`[monitor] Closed stale direct workspace ${ws.wsId}  issue moved to Done`);
          deps.boardEvents.broadcast(ws.projectId, "board_changed");
        } else if (sessionCount >= MAX_SESSIONS) {
          const needsReviewSt = await db.select({ id: projectStatuses.id }).from(projectStatuses).where(sql`${projectStatuses.name} = 'Needs Review' AND ${projectStatuses.projectId} = ${ws.projectId}`).limit(1);
          const inReviewSt = await db.select({ id: projectStatuses.id }).from(projectStatuses).where(sql`${projectStatuses.name} = 'In Review' AND ${projectStatuses.projectId} = ${ws.projectId}`).limit(1);
          const fallbackSt = needsReviewSt[0] ?? inReviewSt[0];
          if (fallbackSt) await db.update(issues).set({ statusId: fallbackSt.id }).where(eq(issues.id, ws.issueId)).catch(() => {});
          await db.update(workspaces).set({ status: "closed", updatedAt: new Date().toISOString() }).where(eq(workspaces.id, ws.wsId)).catch(() => {});
          logAction("mark_idle", ws.wsId, ws.issueId);
          console.log(`[monitor] Workspace ${ws.wsId} has ${sessionCount} sessions  flagged as stuck, closing`);
          deps.boardEvents.broadcast(ws.projectId, "board_changed");
        } else if (sessionCount >= 5 && ws.issueStatusName === "In Review") {
          await db.update(workspaces).set({ status: "closed", updatedAt: new Date().toISOString() }).where(eq(workspaces.id, ws.wsId)).catch(() => {});
          logAction("mark_idle", ws.wsId, ws.issueId);
          console.log(`[monitor] Workspace ${ws.wsId} has ${sessionCount} sessions with issue in review  closing to break review loop (merge or create new workspace)`);
          deps.boardEvents.broadcast(ws.projectId, "board_changed");
        } else if (ws.issueStatusName === "In Review") {
          console.log(`[monitor] Skipping relaunch for idle workspace ${ws.wsId}  issue #${ws.issueNumber} is in review (committed work awaiting merge)`);
        } else {
          await fetch(`http://localhost:${deps.serverPort}/api/workspaces/${ws.wsId}/launch`, { method: "POST" }).catch(() => {});
          stats.relaunched++;
          logAction("relaunch", ws.wsId, ws.issueId);
          console.log(`[monitor] Relaunched idle workspace ${ws.wsId}`);
          deps.boardEvents.broadcast(ws.projectId, "board_changed");
        }
      } else if (ws.wsStatus === "reviewing") {
        if (!ws.workingDir) {
          console.log(`[monitor] Ghost workspace ${ws.wsId} (workingDir empty)  deleting and resetting issue to In Progress`);
          await fetch(`http://localhost:${deps.serverPort}/api/workspaces/${ws.wsId}`, { method: "DELETE" }).catch(() => {});
          const inProgressSt = await db.select({ id: projectStatuses.id }).from(projectStatuses).where(sql`${projectStatuses.name} = 'In Progress' AND ${projectStatuses.projectId} = ${ws.projectId}`).limit(1);
          if (inProgressSt.length > 0) await db.update(issues).set({ statusId: inProgressSt[0].id }).where(eq(issues.id, ws.issueId)).catch(() => {});
          logAction("mark_idle", ws.wsId, ws.issueId);
          deps.boardEvents.broadcast(ws.projectId, "board_changed");
        } else if (sess?.status === "stopped") {
          await fetch(`http://localhost:${deps.serverPort}/api/workspaces/${ws.wsId}/merge`, { method: "POST" }).catch(() => {});
          stats.merged++;
          logAction("merge", ws.wsId, ws.issueId);
          console.log(`[monitor] Triggered merge for reviewing workspace ${ws.wsId}`);
          deps.boardEvents.broadcast(ws.projectId, "board_changed");
        }
      } else if (ws.wsStatus === "active" && sess?.status === "stopped") {
        if (ws.isDirect) {
          const now = new Date().toISOString();
          await db.update(workspaces).set({ status: "closed", workingDir: null, updatedAt: now }).where(eq(workspaces.id, ws.wsId)).catch(() => {});
          const doneStatusRow = await db.select({ id: projectStatuses.id }).from(projectStatuses).where(sql`${projectStatuses.name} = 'Done' AND ${projectStatuses.projectId} = ${ws.projectId}`).limit(1);
          if (doneStatusRow.length > 0) await db.update(issues).set({ statusId: doneStatusRow[0].id, updatedAt: now }).where(eq(issues.id, ws.issueId)).catch(() => {});
          logAction("merge", ws.wsId, ws.issueId);
          console.log(`[monitor] Direct active workspace ${ws.wsId} has stopped session  closing`);
        } else {
          await db.update(workspaces).set({ status: "idle" }).where(eq(workspaces.id, ws.wsId)).catch(() => {});
          logAction("mark_idle", ws.wsId, ws.issueId);
          console.log(`[monitor] Active workspace ${ws.wsId} has stopped session  marking idle for relaunch`);
        }
        deps.boardEvents.broadcast(ws.projectId, "board_changed");
      } else if (ws.wsStatus === "active" && sess?.status === "running") {
        if (!deps.sessionManager.isProcessAlive(sess.id)) {
          await db.update(workspaces).set({ status: "idle" }).where(eq(workspaces.id, ws.wsId)).catch(() => {});
          await db.update(sessions).set({ status: "stopped", endedAt: new Date().toISOString() }).where(eq(sessions.id, sess.id)).catch(() => {});
          logAction("mark_dead", ws.wsId, ws.issueId);
          console.log(`[monitor] Workspace ${ws.wsId} process dead  marking idle`);
          deps.boardEvents.broadcast(ws.projectId, "board_changed");
        } else if (Date.now() - new Date(sess.startedAt).getTime() > 5 * 60 * 1000) {
          const previousNudge = deps.monitorRecentActions.find((a) => a.action === "nudge" && a.workspaceId === ws.wsId);
          if (previousNudge) {
            const excerpts = await deps.getRecentAgentExcerpts(sess.id);
            if (deps.shouldSkipNudge(excerpts)) {
              console.log(`[monitor] Skipping re-nudge for workspace ${ws.wsId}  agent appears to be actively working`);
              continue;
            }
            if (excerpts.length > 0) console.log(`[monitor] Re-nudging workspace ${ws.wsId}  last agent excerpt: "${excerpts[0]?.slice(0, 100)}..."`);
          }
          const nudged = sendMonitorNudge({
            sessionManager: deps.sessionManager,
            sessionId: sess.id,
            workspaceId: ws.wsId,
            issueId: ws.issueId,
            projectId: ws.projectId,
            prompt: await deps.buildMonitorNudgePrompt(ws.projectId),
            logAction: (action, workspaceId, issueId) => logAction(action, workspaceId, issueId),
            broadcast: (projectId, event) => deps.boardEvents.broadcast(projectId, event),
          });
          if (nudged) stats.nudged++;
        }
      }
    } catch (err) {
      console.warn(`[monitor] Error processing workspace ${ws.wsId}:`, err);
    }
  }
  return stats;
}
