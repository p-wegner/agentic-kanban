import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";

export function registerListWorkspaces(server: McpServer) {
  server.tool(
    "list_workspaces",
    "List workspaces, optionally filtered by issue ID",
    {
      issueId: z.string().optional().describe("Filter by issue ID"),
      status: z.string().optional().describe("Filter by status (active, idle, closed)"),
    },
    async ({ issueId, status }) => {
      let query = db.select().from(schema.workspaces);

      // Apply filters
      const conditions = [];
      if (issueId) {
        const result = await db.select().from(schema.workspaces)
          .where(eq(schema.workspaces.issueId, issueId));
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }

      const allWorkspaces = await db.select().from(schema.workspaces);

      const filtered = status
        ? allWorkspaces.filter(w => w.status === status)
        : allWorkspaces;

      return {
        content: [{ type: "text" as const, text: JSON.stringify(filtered, null, 2) }],
      };
    },
  );
}
