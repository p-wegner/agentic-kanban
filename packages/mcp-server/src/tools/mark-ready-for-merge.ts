import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";
import { notifyBoard } from "../notify.js";

export function registerMarkReadyForMerge(server: McpServer) {
  server.tool(
    "mark_ready_for_merge",
    "Mark a workspace as reviewed and ready to merge. Call this after a successful code review with no critical or major issues. This flag allows future agents to merge the workspace without requiring another review.",
    {
      workspaceId: z.string().describe("The workspace ID to mark as ready for merge"),
    },
    async ({ workspaceId }) => {
      const wsRows = await db.select().from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1);
      if (wsRows.length === 0) {
        return { content: [{ type: "text" as const, text: `Workspace ${workspaceId} not found` }] };
      }

      const issueRows = await db.select({ projectId: schema.issues.projectId })
        .from(schema.issues)
        .where(eq(schema.issues.id, wsRows[0].issueId))
        .limit(1);
      const projectId = issueRows[0]?.projectId;

      const now = new Date().toISOString();
      await db.update(schema.workspaces)
        .set({ readyForMerge: true, updatedAt: now })
        .where(eq(schema.workspaces.id, workspaceId));

      if (projectId) notifyBoard(projectId, "workspace_ready_for_merge");

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ id: workspaceId, readyForMerge: true }, null, 2) }],
      };
    },
  );
}
