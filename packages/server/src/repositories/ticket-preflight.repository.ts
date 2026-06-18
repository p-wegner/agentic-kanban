import { eq, and, inArray } from "drizzle-orm";
import { issues, projectStatuses, workflowNodes } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

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

export async function getTerminalStatusIds(
  projectId: string,
  terminalStatusNames: string[],
  database: Database = db,
) {
  const rows = await database
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(
      and(
        eq(projectStatuses.projectId, projectId),
        inArray(projectStatuses.name, terminalStatusNames),
      ),
    );
  return rows.map((s) => s.id);
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
