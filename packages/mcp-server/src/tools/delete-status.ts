import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";
import { notifyBoard } from "../notify.js";

export function registerDeleteStatus(server: McpServer) {
  server.tool(
    "delete_status",
    "Delete a project status. Fails if any issues are linked to it.",
    {
      statusId: z.string().describe("The status ID to delete"),
    },
    async ({ statusId }) => {
      const existing = await db.select({ id: schema.projectStatuses.id, projectId: schema.projectStatuses.projectId, name: schema.projectStatuses.name })
        .from(schema.projectStatuses)
        .where(eq(schema.projectStatuses.id, statusId))
        .limit(1);
      if (existing.length === 0) {
        return { content: [{ type: "text" as const, text: `Status ${statusId} not found` }] };
      }

      const projectId = existing[0].projectId;

      const linkedIssues = await db.select({ id: schema.issues.id })
        .from(schema.issues)
        .where(eq(schema.issues.statusId, statusId))
        .limit(1);
      if (linkedIssues.length > 0) {
        return { content: [{ type: "text" as const, text: `Cannot delete status "${existing[0].name}" — it has linked issues. Move or delete those issues first.` }] };
      }

      await db.delete(schema.projectStatuses).where(eq(schema.projectStatuses.id, statusId));
      notifyBoard(projectId, "mcp_delete_status");

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ id: statusId, name: existing[0].name, deleted: true }, null, 2) }],
      };
    },
  );
}
