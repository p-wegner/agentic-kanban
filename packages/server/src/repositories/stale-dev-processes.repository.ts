import { issues, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/** All workspace working directories (raw, including null/empty) for cleanup-scope derivation. */
export async function getAllWorkspaceWorkingDirs(
  database: Database = db,
): Promise<Array<{ workingDir: string | null }>> {
  return database.select({ workingDir: workspaces.workingDir }).from(workspaces);
}

export interface ActiveWorkspaceResourceRow {
  workspaceId: string;
  issueId: string;
  issueNumber: number | null;
  workingDir: string | null;
  sessionPid: number | null;
}

/**
 * Non-closed workspaces joined to their issue and (if any) their running session's pid.
 * Backs the board monitor's active-resource accounting.
 */
export async function getActiveWorkspaceResourceRows(
  database: Database = db,
): Promise<ActiveWorkspaceResourceRow[]> {
  return database
    .select({
      workspaceId: workspaces.id,
      issueId: issues.id,
      issueNumber: issues.issueNumber,
      workingDir: workspaces.workingDir,
      sessionPid: sessions.pid,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .leftJoin(sessions, and(eq(sessions.workspaceId, workspaces.id), eq(sessions.status, "running")))
    .where(and(sql`${workspaces.status} != 'closed'`, or(isNull(workspaces.closedAt), sql`${workspaces.closedAt} = ''`)));
}
