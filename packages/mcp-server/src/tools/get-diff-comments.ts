import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq, and } from "drizzle-orm";
import { requireEntity } from "../db-utils.js";

export function registerGetDiffComments(server: McpServer) {
  server.tool(
    "get_diff_comments",
    "Get diff review comments for a workspace, optionally filtered by file path",
    {
      workspaceId: z.string().describe("The workspace ID to get comments for"),
      filePath: z.string().optional().describe("Filter comments by file path"),
    },
    async ({ workspaceId, filePath }) => {
      const wsRows = await db.select().from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1);
      const r = requireEntity(wsRows, workspaceId, "Workspace");
      if (!r.ok) return r.error;

      const conditions = [eq(schema.diffComments.workspaceId, workspaceId)];
      if (filePath) {
        conditions.push(eq(schema.diffComments.filePath, filePath));
      }

      const result = await db.select().from(schema.diffComments)
        .where(and(...conditions));

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
