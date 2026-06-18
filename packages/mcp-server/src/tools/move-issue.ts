import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq, ne } from "drizzle-orm";
import { prodDeps, type ToolDeps } from "./deps.js";
import { requireEntity, resolveStatusByName } from "../db-utils.js";
import { syncCurrentNodeToStatus, getOutgoingTransitions } from "@agentic-kanban/shared/lib/workflow-engine";
import { validateWebhookUrl, fireWebhook, buildIssueStatusPayload } from "@agentic-kanban/shared/lib";

/** Status names that represent a terminal (closed) outcome. */
const TERMINAL_STATUSES = new Set(["Done", "Cancelled"]);

/**
 * Guard: reject a terminal-status move when the issue has an open non-direct
 * workspace that has not been merged. Direct workspaces (isDirect=true) commit
 * directly to master — there is no branch to merge, so they are excluded.
 *
 * Blocked when: status != "closed" AND isDirect = false.
 */
async function checkOpenWorkspace(
  db: ToolDeps["db"],
  schema: ToolDeps["schema"],
  issueId: string,
): Promise<{ blocked: boolean; workspaceId?: string; branch?: string }> {
  const openWs = await db
    .select({ id: schema.workspaces.id, branch: schema.workspaces.branch })
    .from(schema.workspaces)
    .where(and(
      eq(schema.workspaces.issueId, issueId),
      ne(schema.workspaces.status, "closed"),
      eq(schema.workspaces.isDirect, false),
    ))
    .limit(1);

  if (openWs.length === 0) return { blocked: false };
  return { blocked: true, workspaceId: openWs[0].id, branch: openWs[0].branch };
}

export function registerMoveIssue(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema, notifyBoard } = deps;
  server.tool(
    "move_issue",
    "Move an issue to a different status column by name (e.g., 'Todo', 'In Progress', 'Done')",
    {
      issueId: z.string().describe("The issue ID to move"),
      statusName: z.string().describe("Target status column name (e.g., 'Todo', 'In Progress', 'In Review', 'Done', 'Cancelled')"),
    },
    async ({ issueId, statusName }) => {
      const existingRows = await db.select({
          projectId: schema.issues.projectId,
          currentNodeId: schema.issues.currentNodeId,
          issueNumber: schema.issues.issueNumber,
          title: schema.issues.title,
        })
        .from(schema.issues)
        .where(eq(schema.issues.id, issueId))
        .limit(1);
      const r0 = requireEntity(existingRows, issueId, "Issue");
      if (!r0.ok) return r0.error;

      const { projectId, currentNodeId, issueNumber, title } = r0.value;

      // Guard: block terminal-status moves when the issue has an open workspace.
      // An agent must call merge_workspace first — that merges the branch AND
      // auto-transitions the issue to Done. Skipping merge_workspace and calling
      // move_issue(Done) directly strands the branch and causes silent merge loss.
      if (TERMINAL_STATUSES.has(statusName)) {
        const check = await checkOpenWorkspace(db, schema, issueId);
        if (check.blocked) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: `Cannot move issue to "${statusName}": it has an open workspace (branch: ${check.branch ?? check.workspaceId}) that has not been merged. Call merge_workspace first to merge the branch into the default branch — merge_workspace will auto-transition the issue to Done. If you want to discard the workspace without merging, call close_workspace or delete_workspace first.`,
                code: "OPEN_WORKSPACE_NOT_MERGED",
                workspaceId: check.workspaceId,
                branch: check.branch,
              }),
            }],
          };
        }
      }

      // For workflow-driven issues: validate that the target status is reachable
      // via an outgoing edge from the current node.
      if (currentNodeId) {
        const transitions = await getOutgoingTransitions(db, currentNodeId);
        const reachable = transitions.some(
          t => t.toStatusName === statusName ||
               t.toStatusName?.toLowerCase() === statusName.toLowerCase(),
        );
        if (transitions.length > 0 && !reachable) {
          const validNames = transitions
            .map(t => t.toStatusName ?? t.toNodeName)
            .filter(Boolean)
            .join(", ");
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: `Transition to "${statusName}" is not a valid next step from the current workflow stage. Valid next stages: ${validNames || "(none — terminal stage)"}. Use propose_transition to advance the workflow, or move_issue only for issues not on a workflow.`,
                code: "WORKFLOW_TRANSITION_INVALID",
              }),
            }],
          };
        }
      }

      const r = await resolveStatusByName(db, schema, projectId, statusName);
      if (!r.ok) return r.error;

      const now = new Date().toISOString();
      await db.update(schema.issues)
        .set({ statusId: r.statusId, statusChangedAt: now, updatedAt: now })
        .where(eq(schema.issues.id, issueId));

      // Keep currentNode consistent with the new status for workflow-driven issues.
      await syncCurrentNodeToStatus(db, issueId).catch(() => {});

      notifyBoard(projectId, "mcp_move_issue");

      // Fire outbound webhook if configured for this project (best-effort)
      const webhookPref = await db
        .select({ value: schema.preferences.value })
        .from(schema.preferences)
        .where(eq(schema.preferences.key, `outbound_webhook_url_${projectId}`))
        .limit(1)
        .then((rows) => rows[0]?.value ?? null)
        .catch(() => null);
      const webhookUrl = validateWebhookUrl(webhookPref);
      if (webhookUrl) {
        fireWebhook(webhookUrl, buildIssueStatusPayload({
          issueId,
          issueNumber,
          title,
          projectId,
          newStatusId: r.statusId,
          newStatusName: statusName,
          statusChangedAt: now,
        }));
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ id: issueId, movedTo: statusName }, null, 2) }],
      };
    },
  );
}
