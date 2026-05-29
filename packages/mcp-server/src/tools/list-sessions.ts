import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";
import { requireEntity } from "../db-utils.js";

export function registerListSessions(server: McpServer) {
  server.tool(
    "list_sessions",
    "List all sessions for a workspace, including status and timing",
    {
      workspaceId: z.string().describe("The workspace ID to list sessions for"),
    },
    async ({ workspaceId }) => {
      const wsRows = await db.select().from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1);
      const r = requireEntity(wsRows, workspaceId, "Workspace");
      if (!r.ok) return r.error;

      const result = await db.select().from(schema.sessions)
        .where(eq(schema.sessions.workspaceId, workspaceId));

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
