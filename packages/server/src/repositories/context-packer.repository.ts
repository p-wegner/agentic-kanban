import { eq, and, ne, like, or } from "drizzle-orm";
import { issues, projectStatuses, agentSkills, workflowNodes } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getCandidateIssuesForProject(
  projectId: string,
  excludeIssueId: string,
  database: Database = db,
) {
  return database
    .select({
      issueNumber: issues.issueNumber,
      title: issues.title,
      description: issues.description,
      statusName: projectStatuses.name,
      currentNodeId: issues.currentNodeId,
      currentNodeType: workflowNodes.nodeType,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
    .where(and(eq(issues.projectId, projectId), ne(issues.id, excludeIssueId)))
    .limit(100);
}

export async function getIssuesMatchingFileBaseNames(
  projectId: string,
  excludeIssueId: string,
  fileBaseNames: string[],
  database: Database = db,
) {
  const nameConditions = fileBaseNames
    .slice(0, 5)
    .map((n) => or(like(issues.title, `%${n}%`), like(issues.description, `%${n}%`)));

  const orCondition = nameConditions.length === 1
    ? nameConditions[0]!
    : or(...nameConditions as [ReturnType<typeof like>, ...ReturnType<typeof like>[]]);

  return database
    .select({
      issueNumber: issues.issueNumber,
      title: issues.title,
      statusName: projectStatuses.name,
      currentNodeId: issues.currentNodeId,
      currentNodeType: workflowNodes.nodeType,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
    .where(and(eq(issues.projectId, projectId), ne(issues.id, excludeIssueId), orCondition))
    .limit(20);
}

export async function getBuiltinAgentSkills(database: Database = db) {
  return database
    .select({ name: agentSkills.name, description: agentSkills.description })
    .from(agentSkills)
    .where(eq(agentSkills.isBuiltin, true));
}
