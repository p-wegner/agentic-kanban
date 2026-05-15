import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq, inArray } from "drizzle-orm";
import { notifyBoard } from "../notify.js";

export function registerDeleteIssue(server: McpServer) {
  server.tool(
    "delete_issue",
    "Delete an issue and all its associated data (workspaces, sessions, messages, tags)",
    {
      issueId: z.string().describe("The issue ID to delete"),
    },
    async ({ issueId }) => {
      const existing = await db.select({ projectId: schema.issues.projectId })
        .from(schema.issues)
        .where(eq(schema.issues.id, issueId))
        .limit(1);
      if (existing.length === 0) {
        return { content: [{ type: "text" as const, text: `Issue ${issueId} not found` }] };
      }

      const projectId = existing[0].projectId;

      // Cascade delete workspaces and their sessions/messages
      const wsRows = await db.select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.issueId, issueId));

      for (const ws of wsRows) {
        const wsSessions = await db.select({ id: schema.sessions.id })
          .from(schema.sessions)
          .where(eq(schema.sessions.workspaceId, ws.id));
        await db.delete(schema.diffComments).where(eq(schema.diffComments.workspaceId, ws.id));
        if (wsSessions.length > 0) {
          await db.delete(schema.sessionMessages)
            .where(inArray(schema.sessionMessages.sessionId, wsSessions.map(s => s.id)));
        }
        await db.delete(schema.sessions).where(eq(schema.sessions.workspaceId, ws.id));
        await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws.id));
      }

      await db.delete(schema.issueTags).where(eq(schema.issueTags.issueId, issueId));
      await db.delete(schema.issues).where(eq(schema.issues.id, issueId));

      notifyBoard(projectId, "mcp_delete_issue");

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ id: issueId, deleted: true }, null, 2) }],
      };
    },
  );
}
