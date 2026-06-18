import { and, eq, like, sql } from "drizzle-orm";
import { issueArtifacts, issues, workflowNodes, workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getWorkspaceArtifactTarget(
  workspaceId: string,
  issueId: string,
  database: Database = db,
) {
  const rows = await database
    .select({
      issueNumber: issues.issueNumber,
      title: issues.title,
      workingDir: workspaces.workingDir,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.issueId, issueId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getWorkspaceIssueId(
  workspaceId: string,
  database: Database = db,
): Promise<string | undefined> {
  const rows = await database
    .select({ issueId: workspaces.issueId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return rows[0]?.issueId;
}

export async function getLatestPhaseArtifact(
  issueId: string,
  workspaceId: string,
  caption: string,
  database: Database = db,
) {
  const rows = await database
    .select({
      id: issueArtifacts.id,
      content: issueArtifacts.content,
      caption: issueArtifacts.caption,
    })
    .from(issueArtifacts)
    .where(and(
      eq(issueArtifacts.issueId, issueId),
      eq(issueArtifacts.workspaceId, workspaceId),
      eq(issueArtifacts.type, "text"),
      eq(issueArtifacts.caption, caption),
    ))
    .orderBy(sql`${issueArtifacts.createdAt} DESC`)
    .limit(1);
  return rows[0] ?? null;
}

export async function getPhaseArtifactRows(
  issueId: string,
  workspaceId: string | null | undefined,
  database: Database = db,
) {
  const conditions = [
    eq(issueArtifacts.issueId, issueId),
    eq(issueArtifacts.type, "text"),
    like(issueArtifacts.caption, "phase-artifact:%"),
  ];
  if (workspaceId) conditions.push(eq(issueArtifacts.workspaceId, workspaceId));

  return database
    .select({
      caption: issueArtifacts.caption,
      content: issueArtifacts.content,
      createdAt: issueArtifacts.createdAt,
    })
    .from(issueArtifacts)
    .where(and(...conditions))
    .orderBy(issueArtifacts.createdAt);
}

export async function getWorkflowNodeName(
  nodeId: string,
  database: Database = db,
): Promise<string | null | undefined> {
  const rows = await database
    .select({ name: workflowNodes.name })
    .from(workflowNodes)
    .where(eq(workflowNodes.id, nodeId))
    .limit(1);
  return rows[0]?.name;
}
