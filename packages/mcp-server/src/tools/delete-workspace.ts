import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq, inArray } from "drizzle-orm";
import { notifyBoard } from "../notify.js";
import { requireEntity } from "../db-utils.js";

export function registerDeleteWorkspace(server: McpServer) {
  server.tool(
    "delete_workspace",
    "Delete a workspace and all its sessions, messages, and diff comments",
    {
      workspaceId: z.string().describe("The workspace ID to delete"),
    },
    async ({ workspaceId }) => {
      const wsRows = await db.select().from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1);
      const r = requireEntity(wsRows, workspaceId, "Workspace");
      if (!r.ok) return r.error;

      // Resolve projectId for board notification
      const issueRows = await db.select({ projectId: schema.issues.projectId })
        .from(schema.issues)
        .where(eq(schema.issues.id, r.value.issueId))
        .limit(1);

      // Get sessions for cascade delete
      const wsSessions = await db.select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(eq(schema.sessions.workspaceId, workspaceId));

      // Delete cascade: diff comments → session messages → sessions → workspace
      await db.delete(schema.diffComments).where(eq(schema.diffComments.workspaceId, workspaceId));
      if (wsSessions.length > 0) {
        await db.delete(schema.sessionMessages)
          .where(inArray(schema.sessionMessages.sessionId, wsSessions.map(s => s.id)));
      }
      await db.delete(schema.sessions).where(eq(schema.sessions.workspaceId, workspaceId));
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));

      if (issueRows[0]?.projectId) {
        notifyBoard(issueRows[0].projectId, "mcp_delete_workspace");
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ id: workspaceId, deleted: true }, null, 2) }],
      };
    },
  );
}
