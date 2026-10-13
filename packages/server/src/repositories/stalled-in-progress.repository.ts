import { and, desc, eq } from "drizzle-orm";
import { issues, projectStatuses, sessions, workspaces } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";

export interface StalledInProgressCandidate {
  workspaceId: string;
  issueId: string;
  projectId: string;
  issueNumber: number | null;
  workingDir: string | null;
  baseBranch: string | null;
  planMode: boolean;
  parentWorkspaceId: string | null;
  forkStatus: string | null;
  /** True when ANY session of the workspace is still `running`. */
  hasRunningSession: boolean;
  lastSessionId: string | null;
  lastSessionTriggerType: string | null;
  lastSessionEndedAt: string | null;
}

/**
 * Open, non-direct workspaces that sit `idle` under an In Progress issue, each with the facts
 * about its newest session the stalled-in-progress sweep decides on. Pure reads.
 */
export async function listIdleInProgressWorkspaces(database: Database = db): Promise<StalledInProgressCandidate[]> {
  const rows = await database
    .select({
      workspaceId: workspaces.id,
      issueId: issues.id,
      projectId: issues.projectId,
      issueNumber: issues.issueNumber,
      workingDir: workspaces.workingDir,
      baseBranch: workspaces.baseBranch,
      planMode: workspaces.planMode,
      parentWorkspaceId: workspaces.parentWorkspaceId,
      forkStatus: workspaces.forkStatus,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(and(eq(workspaces.status, "idle"), eq(workspaces.isDirect, false), eq(projectStatuses.name, "In Progress")));

  const out: StalledInProgressCandidate[] = [];
  for (const r of rows) {
    const recent = await database
      .select({ id: sessions.id, status: sessions.status, triggerType: sessions.triggerType, endedAt: sessions.endedAt })
      .from(sessions)
      .where(eq(sessions.workspaceId, r.workspaceId))
      .orderBy(desc(sessions.startedAt))
      .limit(5);
    out.push({
      ...r,
      hasRunningSession: recent.some((s) => s.status === "running"),
      lastSessionId: recent[0]?.id ?? null,
      lastSessionTriggerType: recent[0]?.triggerType ?? null,
      lastSessionEndedAt: recent[0]?.endedAt ?? null,
    });
  }
  return out;
}
