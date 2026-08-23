import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { issues, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { firstRow } from "@agentic-kanban/shared/lib/first-row";

export async function getIssueDescriptionAndProject(
  issueId: string,
  database: Database = db,
) {
  return firstRow(
    database
      .select({ description: issues.description, projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1)
  );
}

export async function getOtherProjectWorkspaceIds(
  projectId: string,
  excludeIssueId: string,
  database: Database = db,
) {
  return database
    .select({ id: workspaces.id })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(
      and(
        eq(issues.projectId, projectId),
        ne(workspaces.issueId, excludeIssueId),
      ),
    );
}

export async function getRecentSessionStats(
  workspaceIds: string[],
  limit: number,
  database: Database = db,
) {
  return database
    .select({ stats: sessions.stats })
    .from(sessions)
    .where(inArray(sessions.workspaceId, workspaceIds))
    .orderBy(desc(sessions.startedAt))
    .limit(limit);
}
