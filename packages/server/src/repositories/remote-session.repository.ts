// Rows the boot-time remote-session recovery pass needs (#745).
//
// Its own module rather than drizzle in `startup/`: the
// `startup-bypasses-repositories` rule exists because 30 files in `startup/` reach
// the DB directly, and a NEW pass should not add the 31st.

import { and, desc, eq, isNotNull } from "drizzle-orm";
import { issues, projects, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export interface RunningWorkerSessionRow {
  sessionId: string;
  workerId: string | null;
  startedAt: string;
  executor: string | null;
  workspaceId: string;
  branch: string;
  issueId: string;
  projectId: string;
  repoPath: string | null;
}

/**
 * Every `running` session stamped with a fleet worker, with the workspace/issue/project
 * context the recovery pass needs to re-adopt it (`reattachSession` wants the ids; the
 * branch + repoPath are what let an adopted session's exit land its pushed result).
 */
export async function listRunningWorkerSessions(
  database: Database = db,
): Promise<RunningWorkerSessionRow[]> {
  return database
    .select({
      sessionId: sessions.id,
      workerId: sessions.workerId,
      startedAt: sessions.startedAt,
      executor: sessions.executor,
      workspaceId: workspaces.id,
      branch: workspaces.branch,
      issueId: workspaces.issueId,
      projectId: issues.projectId,
      repoPath: projects.repoPath,
    })
    .from(sessions)
    .innerJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .innerJoin(projects, eq(issues.projectId, projects.id))
    .where(and(eq(sessions.status, "running"), isNotNull(sessions.workerId)));
}

/**
 * The workspace's MOST RECENT session, with the worker it ran on (null = it ran on the host).
 * Where a workspace's builder is placed decides where its dev server and compose stack run (#1447).
 */
export async function getLatestSessionPlacement(
  workspaceId: string,
  database: Database = db,
): Promise<{ sessionId: string; workerId: string | null; status: string } | null> {
  const rows = await database
    .select({ sessionId: sessions.id, workerId: sessions.workerId, status: sessions.status })
    .from(sessions)
    .where(eq(sessions.workspaceId, workspaceId))
    .orderBy(desc(sessions.startedAt))
    .limit(1);
  return rows[0] ?? null;
}
