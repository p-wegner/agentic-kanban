import {
  workflowTemplates,
  workflowNodes,
  workflowEdges,
  workflowTransitions,
  issues,
  workspaces,
} from "@agentic-kanban/shared/schema";
import { and, eq, asc, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/** Load a template's nodes + edges as a graph payload. */
export async function loadGraph(database: Database, templateId: string) {
  const [nodes, edges] = await Promise.all([
    database
      .select()
      .from(workflowNodes)
      .where(eq(workflowNodes.templateId, templateId))
      .orderBy(asc(workflowNodes.sortOrder)),
    database
      .select()
      .from(workflowEdges)
      .where(eq(workflowEdges.templateId, templateId))
      .orderBy(asc(workflowEdges.sortOrder)),
  ]);
  return { nodes, edges };
}

export async function listTemplateRows(
  opts: { projectId?: string },
  database: Database = db,
) {
  return database
    .select()
    .from(workflowTemplates)
    .where(
      opts.projectId
        ? sql`${workflowTemplates.projectId} = ${opts.projectId} OR ${workflowTemplates.projectId} IS NULL`
        : sql`1 = 1`,
    );
}

export async function getTemplateRow(
  id: string,
  database: Database = db,
) {
  return database
    .select()
    .from(workflowTemplates)
    .where(eq(workflowTemplates.id, id))
    .limit(1);
}

export async function insertTemplate(
  values: {
    id: string;
    projectId: string;
    name: string;
    description: string | null;
    ticketType: string | null;
    isDefault: boolean;
    isBuiltin: boolean;
    builtinKey: string | null;
    createdAt: string;
    updatedAt: string;
  },
  database: Database = db,
): Promise<void> {
  await database.insert(workflowTemplates).values(values);
}

export async function updateTemplateRow(
  id: string,
  values: {
    name: string;
    description: string | null;
    ticketType: string | null;
    isDefault: boolean;
    updatedAt: string;
  },
  database: Database = db,
): Promise<void> {
  await database.update(workflowTemplates).set(values).where(eq(workflowTemplates.id, id));
}

export async function deleteTemplateCascade(
  id: string,
  database: Database = db,
): Promise<void> {
  await database.delete(workflowEdges).where(eq(workflowEdges.templateId, id));
  await database.delete(workflowNodes).where(eq(workflowNodes.templateId, id));
  await database.delete(workflowTemplates).where(eq(workflowTemplates.id, id));
}

export async function getAnalyticsRows(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({
      workspaceId: workflowTransitions.workspaceId,
      toNodeId: workflowTransitions.toNodeId,
      createdAt: workflowTransitions.createdAt,
      nodeName: workflowNodes.name,
      nodeType: workflowNodes.nodeType,
      templateId: workflowNodes.templateId,
      templateName: workflowTemplates.name,
      sortOrder: workflowNodes.sortOrder,
    })
    .from(workflowTransitions)
    .innerJoin(workspaces, eq(workflowTransitions.workspaceId, workspaces.id))
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .leftJoin(workflowNodes, eq(workflowTransitions.toNodeId, workflowNodes.id))
    .leftJoin(workflowTemplates, eq(workflowNodes.templateId, workflowTemplates.id))
    .where(eq(issues.projectId, projectId));
}

export async function getStageNodeRow(
  templateId: string,
  nodeId: string,
  database: Database = db,
) {
  return database
    .select({ id: workflowNodes.id, name: workflowNodes.name, nodeType: workflowNodes.nodeType })
    .from(workflowNodes)
    .where(and(eq(workflowNodes.id, nodeId), eq(workflowNodes.templateId, templateId)))
    .limit(1);
}

export async function getStageVisitRows(
  projectId: string | undefined,
  database: Database = db,
) {
  const baseQuery = database
    .select({
      workspaceId: workflowTransitions.workspaceId,
      workspaceName: workspaces.branch,
      issueId: issues.id,
      issueNumber: issues.issueNumber,
      issueTitle: issues.title,
      toNodeId: workflowTransitions.toNodeId,
      enteredAt: workflowTransitions.createdAt,
      currentNodeId: workspaces.currentNodeId,
    })
    .from(workflowTransitions)
    .innerJoin(workspaces, eq(workflowTransitions.workspaceId, workspaces.id))
    .innerJoin(issues, eq(workspaces.issueId, issues.id));

  return projectId ? baseQuery.where(eq(issues.projectId, projectId)) : baseQuery;
}

export async function getIssueResolveRow(
  issueId: string,
  database: Database = db,
) {
  return database
    .select({
      projectId: issues.projectId,
      issueType: issues.issueType,
      workflowTemplateId: issues.workflowTemplateId,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
}

export async function getWorkspaceProgressRow(
  workspaceId: string,
  database: Database = db,
) {
  return database
    .select({
      id: workspaces.id,
      issueId: workspaces.issueId,
      currentNodeId: workspaces.currentNodeId,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
}

export async function getIssueTemplateIdRow(
  issueId: string,
  database: Database = db,
) {
  return database
    .select({ workflowTemplateId: issues.workflowTemplateId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
}

export async function getWorkspaceTransitions(
  workspaceId: string,
  database: Database = db,
) {
  return database
    .select()
    .from(workflowTransitions)
    .where(eq(workflowTransitions.workspaceId, workspaceId))
    .orderBy(asc(workflowTransitions.createdAt));
}

export async function getCurrentNodeRow(
  workspaceId: string,
  database: Database = db,
) {
  return database
    .select({ currentNodeId: workspaces.currentNodeId, nodeName: workflowNodes.name })
    .from(workspaces)
    .leftJoin(workflowNodes, eq(workspaces.currentNodeId, workflowNodes.id))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
}

export async function getWorkspaceProjectRow(
  workspaceId: string,
  database: Database = db,
) {
  return database
    .select({ projectId: issues.projectId })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
}
