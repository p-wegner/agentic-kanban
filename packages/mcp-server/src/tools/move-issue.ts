import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";
import { notifyBoard } from "../notify.js";
import { syncCurrentNodeToStatus, getOutgoingTransitions } from "@agentic-kanban/shared/lib/workflow-engine";
import { requireEntity, resolveStatusByName } from "../db-utils.js";

export function registerMoveIssue(server: McpServer) {
  server.tool(
    "move_issue",
    "Move an issue to a different status column by name (e.g., 'Todo', 'In Progress', 'Done')",
    {
      issueId: z.string().describe("The issue ID to move"),
      statusName: z.string().describe("Target status column name (e.g., 'Todo', 'In Progress', 'In Review', 'Done', 'Cancelled')"),
    },
    async ({ issueId, statusName }) => {
      const existingRows = await db.select({ projectId: schema.issues.projectId, currentNodeId: schema.issues.currentNodeId })
        .from(schema.issues)
        .where(eq(schema.issues.id, issueId))
        .limit(1);
      const r0 = requireEntity(existingRows, issueId, "Issue");
      if (!r0.ok) return r0.error;

      const { projectId, currentNodeId } = r0.value;

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

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ id: issueId, movedTo: statusName }, null, 2) }],
      };
    },
  );
}
