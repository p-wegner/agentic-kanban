import { and, eq, or, sql } from "drizzle-orm";
import { issueArtifacts, issueDependencies, issues, projectStatuses, workspaces, workflowNodes } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";

/** Accepts either the top-level db handle or a transaction handle. */
type DbOrTx = Database | TransactionClient;

export async function getWorkspaceMaterializationContext(
  workspaceId: string,
  database: DbOrTx = db,
) {
  const rows = await database
    .select({
      issueId: workspaces.issueId,
      currentNodeId: workspaces.currentNodeId,
      nodeName: workflowNodes.name,
      projectId: issues.projectId,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .leftJoin(workflowNodes, eq(workspaces.currentNodeId, workflowNodes.id))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getExistingChildLinks(
  issueId: string,
  database: DbOrTx = db,
) {
  return database
    .select({ id: issueDependencies.id })
    .from(issueDependencies)
    .where(or(
      and(eq(issueDependencies.dependsOnId, issueId), eq(issueDependencies.type, "child_of")),
      and(eq(issueDependencies.issueId, issueId), eq(issueDependencies.type, "parent_of")),
    ))
    .limit(1);
}

export async function getLatestTasksArtifact(
  issueId: string,
  workspaceId: string,
  database: DbOrTx = db,
) {
  const rows = await database
    .select({ content: issueArtifacts.content, createdAt: issueArtifacts.createdAt })
    .from(issueArtifacts)
    .where(and(
      eq(issueArtifacts.issueId, issueId),
      eq(issueArtifacts.workspaceId, workspaceId),
      eq(issueArtifacts.caption, "phase-artifact:tasks"),
    ))
    .orderBy(sql`${issueArtifacts.createdAt} DESC`)
    .limit(1);
  return rows[0] ?? null;
}

export async function getBacklogStatusId(
  projectId: string,
  database: DbOrTx = db,
): Promise<string | undefined> {
  const backlogRows = await database
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(and(eq(projectStatuses.projectId, projectId), eq(projectStatuses.name, "Backlog")))
    .limit(1);
  const defaultRows = backlogRows.length > 0
    ? backlogRows
    : await database
        .select({ id: projectStatuses.id })
        .from(projectStatuses)
        .where(eq(projectStatuses.projectId, projectId))
        .orderBy(projectStatuses.sortOrder)
        .limit(1);
  return defaultRows[0]?.id;
}

export async function insertMaterializedIssue(
  values: {
    id: string;
    issueNumber: number;
    title: string;
    description: string;
    priority: "low" | "medium" | "high" | "critical";
    statusId: string;
    projectId: string;
    createdAt: string;
    updatedAt: string;
  },
  database: DbOrTx = db,
): Promise<void> {
  await database.insert(issues).values({
    id: values.id,
    issueNumber: values.issueNumber,
    title: values.title,
    description: values.description,
    priority: values.priority,
    issueType: "task",
    skipAutoReview: false,
    estimate: null,
    sortOrder: 0,
    statusId: values.statusId,
    projectId: values.projectId,
    createdAt: values.createdAt,
    updatedAt: values.updatedAt,
  });
}

export async function insertIssueDependency(
  values: {
    id: string;
    issueId: string;
    dependsOnId: string;
    type: typeof issueDependencies.$inferInsert["type"];
    createdAt: string;
  },
  database: DbOrTx = db,
): Promise<void> {
  await database.insert(issueDependencies).values({
    id: values.id,
    issueId: values.issueId,
    dependsOnId: values.dependsOnId,
    type: values.type,
    createdAt: values.createdAt,
  });
}
