import { eq } from "drizzle-orm";
import { issues, workflowNodes } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getStatusIdsByName } from "./project-status.repository.js";

export async function getPreflightTargetIssue(
  issueId: string,
  database: Database = db,
) {
  const rows = await database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      description: issues.description,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return rows[0] ?? null;
}

/** #502: one query, in project-status.repository. Kept as a named re-export so callers are unchanged. */
export async function getTerminalStatusIds(
  projectId: string,
  terminalStatusNames: string[],
  database: Database = db,
): Promise<string[]> {
  return getStatusIdsByName(projectId, terminalStatusNames, database);
}

export async function getProjectIssuesWithNodeType(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      description: issues.description,
      statusId: issues.statusId,
      currentNodeId: issues.currentNodeId,
      currentNodeType: workflowNodes.nodeType,
    })
    .from(issues)
    .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
    .where(eq(issues.projectId, projectId));
}
