import { eq } from "drizzle-orm";
import * as schema from "../../schema/index.js";
import type { WorkflowDb, WorkflowNodeRow, TransitionTarget } from "./types.js";
import { getStartNode, getOutgoingTransitions } from "./node-queries.js";
import { resolveTemplateForIssue } from "./templates.js";
import { resolveStatusId } from "./status-resolution.js";

/**
 * Read-only resolution of an issue's workflow start node + its transitions,
 * for building the agent prompt / choosing the node's skill BEFORE the
 * workspace row exists. Returns null when the issue has no workflow.
 */
export async function resolveWorkflowStart(
  db: WorkflowDb,
  issueId: string,
): Promise<{ templateId: string; node: WorkflowNodeRow; transitions: TransitionTarget[] } | null> {
  const issueRows = await db
    .select({
      projectId: schema.issues.projectId,
      issueType: schema.issues.issueType,
      workflowTemplateId: schema.issues.workflowTemplateId,
    })
    .from(schema.issues)
    .where(eq(schema.issues.id, issueId))
    .limit(1);
  if (issueRows.length === 0) return null;
  const issue = issueRows[0];

  const templateId = await resolveTemplateForIssue(db, {
    projectId: issue.projectId,
    issueType: issue.issueType,
    explicitTemplateId: issue.workflowTemplateId,
  });
  if (!templateId) return null;

  const node = await getStartNode(db, templateId);
  if (!node) return null;

  const transitions = await getOutgoingTransitions(db, node.id);
  return { templateId, node, transitions };
}

/**
 * Initialise the workflow for a freshly created workspace: resolve the issue's
 * template (persisting it on the issue if not already set), place the workspace
 * on the start node, record the initial transition, and sync the issue status.
 *
 * Returns the start node + its transitions so the caller can inject guidance
 * into the agent prompt. Returns null when the issue has no workflow.
 */
export async function initWorkspaceWorkflow(
  db: WorkflowDb,
  opts: { workspaceId: string; issueId: string },
): Promise<{ node: WorkflowNodeRow; transitions: TransitionTarget[] } | null> {
  const { workspaceId, issueId } = opts;
  const issueRows = await db
    .select({
      id: schema.issues.id,
      projectId: schema.issues.projectId,
      issueType: schema.issues.issueType,
      workflowTemplateId: schema.issues.workflowTemplateId,
    })
    .from(schema.issues)
    .where(eq(schema.issues.id, issueId))
    .limit(1);
  if (issueRows.length === 0) return null;
  const issue = issueRows[0];

  const templateId = await resolveTemplateForIssue(db, {
    projectId: issue.projectId,
    issueType: issue.issueType,
    explicitTemplateId: issue.workflowTemplateId,
  });
  if (!templateId) return null;

  const startNode = await getStartNode(db, templateId);
  if (!startNode) return null;

  const now = new Date().toISOString();

  // Persist the resolved template + current node on the issue.
  const issueUpdate: Record<string, unknown> = {
    workflowTemplateId: templateId,
    currentNodeId: startNode.id,
    updatedAt: now,
  };
  if (startNode.statusName) {
    const statusId = await resolveStatusId(db, issue.projectId, startNode.statusName);
    if (statusId) {
      issueUpdate.statusId = statusId;
      issueUpdate.statusChangedAt = now;
    }
  }
  await db.update(schema.issues).set(issueUpdate).where(eq(schema.issues.id, issueId));

  await db
    .update(schema.workspaces)
    .set({ currentNodeId: startNode.id, updatedAt: now })
    .where(eq(schema.workspaces.id, workspaceId));

  await db.insert(schema.workflowTransitions).values({
    id: crypto.randomUUID(),
    workspaceId,
    fromNodeId: null,
    toNodeId: startNode.id,
    summary: "Workspace started",
    triggeredBy: "system",
    createdAt: now,
  });

  const transitions = await getOutgoingTransitions(db, startNode.id);
  return { node: startNode, transitions };
}
