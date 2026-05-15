import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq, desc } from "drizzle-orm";

export function registerGetSessionStats(server: McpServer) {
  server.tool(
    "get_session_stats",
    "Get token usage, cost, and duration stats for a session",
    {
      sessionId: z.string().optional().describe("Session ID to get stats for"),
      workspaceId: z.string().optional().describe("Workspace ID — returns stats for the latest session in this workspace"),
    },
    async ({ sessionId, workspaceId }) => {
      let targetSessionId = sessionId;

      // If workspaceId provided, find the latest session for it
      if (!targetSessionId && workspaceId) {
        const wsSessions = await db
          .select({ id: schema.sessions.id })
          .from(schema.sessions)
          .where(eq(schema.sessions.workspaceId, workspaceId))
          .orderBy(desc(schema.sessions.startedAt))
          .limit(1);

        if (wsSessions.length === 0) {
          return { content: [{ type: "text" as const, text: "No sessions found for this workspace" }] };
        }
        targetSessionId = wsSessions[0].id;
      }

      if (!targetSessionId) {
        return { content: [{ type: "text" as const, text: "Provide either sessionId or workspaceId" }] };
      }

      const rows = await db
        .select({ id: schema.sessions.id, status: schema.sessions.status, stats: schema.sessions.stats, startedAt: schema.sessions.startedAt, endedAt: schema.sessions.endedAt })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, targetSessionId))
        .limit(1);

      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: `Session ${targetSessionId} not found` }] };
      }

      const session = rows[0];
      if (!session.stats) {
        return { content: [{ type: "text" as const, text: `No stats available for session ${targetSessionId} (session may still be running or stats were not captured)` }] };
      }

      let stats: Record<string, unknown>;
      try {
        stats = JSON.parse(session.stats);
      } catch {
        return { content: [{ type: "text" as const, text: `Invalid stats data for session ${targetSessionId}` }] };
      }
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            sessionId: session.id,
            status: session.status,
            startedAt: session.startedAt,
            endedAt: session.endedAt,
            ...stats,
          }, null, 2),
        }],
      };
    },
  );
}
