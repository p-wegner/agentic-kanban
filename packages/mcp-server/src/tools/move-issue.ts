import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";
import { notifyBoard } from "../notify.js";
import { syncCurrentNodeToStatus } from "@agentic-kanban/shared/lib/workflow-engine";

export function registerMoveIssue(server: McpServer) {
  server.tool(
    "move_issue",
    "Move an issue to a different status column by name (e.g., 'Todo', 'In Progress', 'Done')",
    {
      issueId: z.string().describe("The issue ID to move"),
      statusName: z.string().describe("Target status column name (e.g., 'Todo', 'In Progress', 'In Review', 'Done', 'Cancelled')"),
    },
    async ({ issueId, statusName }) => {
      const existing = await db.select({ projectId: schema.issues.projectId })
        .from(schema.issues)
        .where(eq(schema.issues.id, issueId))
        .limit(1);
      if (existing.length === 0) {
        return { content: [{ type: "text" as const, text: `Issue ${issueId} not found` }] };
      }

      const projectId = existing[0].projectId;

      const statuses = await db.select().from(schema.projectStatuses)
        .where(eq(schema.projectStatuses.projectId, projectId));
      const target = statuses.find(s => s.name === statusName);
      if (!target) {
        return {
          content: [{
            type: "text" as const,
            text: `Status '${statusName}' not found. Available: ${statuses.map(s => s.name).join(", ")}`,
          }],
        };
      }

      const now = new Date().toISOString();
      await db.update(schema.issues)
        .set({ statusId: target.id, statusChangedAt: now, updatedAt: now })
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
