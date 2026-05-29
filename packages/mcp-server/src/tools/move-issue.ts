import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";
import { notifyBoard } from "../notify.js";
import { syncCurrentNodeToStatus } from "@agentic-kanban/shared/lib/workflow-engine";
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
      const existingRows = await db.select({ projectId: schema.issues.projectId })
        .from(schema.issues)
        .where(eq(schema.issues.id, issueId))
        .limit(1);
      const r0 = requireEntity(existingRows, issueId, "Issue");
      if (!r0.ok) return r0.error;

      const projectId = r0.value.projectId;

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
