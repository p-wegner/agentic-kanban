import { and, eq, asc, sql } from "drizzle-orm";
import * as schema from "../../schema/index.js";
import type { WorkflowDb } from "./types.js";

/**
 * Keep currentNodeId consistent when an issue's status is changed manually
 * (drag-drop, move_issue, CLI). If the issue runs a workflow, point currentNodeId
 * at a node in its template whose statusName matches the issue's (new) status.
 * No-op when the issue has no workflow or no node maps to the status.
 */
export async function syncCurrentNodeToStatus(db: WorkflowDb, issueId: string): Promise<void> {
  const issueRows = await db
    .select({ workflowTemplateId: schema.issues.workflowTemplateId, statusId: schema.issues.statusId, currentNodeId: schema.issues.currentNodeId })
    .from(schema.issues)
    .where(eq(schema.issues.id, issueId))
    .limit(1);
  const issue = issueRows[0];
  if (!issue?.workflowTemplateId || !issue.statusId) return;

  const statusRows = await db
    .select({ name: schema.projectStatuses.name })
    .from(schema.projectStatuses)
    .where(eq(schema.projectStatuses.id, issue.statusId))
    .limit(1);
  const statusName = statusRows[0]?.name;
  if (!statusName) return;

  const nodes = await db
    .select()
    .from(schema.workflowNodes)
    .where(eq(schema.workflowNodes.templateId, issue.workflowTemplateId))
    .orderBy(asc(schema.workflowNodes.sortOrder));
  // If the current node already maps to this status, leave it; else pick the first match.
  const current = nodes.find((n) => n.id === issue.currentNodeId);
  if (current && current.statusName === statusName) return;
  const match = nodes.find((n) => n.statusName === statusName);
  if (match) {
    await db.update(schema.issues).set({ currentNodeId: match.id }).where(eq(schema.issues.id, issueId));
    // Also sync non-closed workspaces so the board's workflow-status override
    // reflects the new node immediately (workspaces.currentNodeId drives the
    // board column override in getBoard(); without this the board keeps showing
    // the old workflow column until the workspace-summary cache rebuilds).
    await db
      .update(schema.workspaces)
      .set({ currentNodeId: match.id })
      .where(and(eq(schema.workspaces.issueId, issueId), sql`${schema.workspaces.status} != 'closed'`));
  }
}
