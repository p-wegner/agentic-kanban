import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";
import { requireEntity } from "../db-utils.js";

// Strip ANSI escape sequences
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\].*?\x07/g, "")
    .replace(/\x1b\[.*?[mGKH]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

export function registerReadTerminal(server: McpServer) {
  server.tool(
    "read_terminal",
    "Read agent session output (terminal messages) for a session. Returns the last N messages, stripped of ANSI codes.",
    {
      sessionId: z.string().describe("The session ID to read output from"),
      limit: z.number().optional().describe("Number of most recent messages to return (default 200, max 2000)"),
    },
    async ({ sessionId, limit }) => {
      const maxLimit = 2000;
      const effectiveLimit = Math.min(limit ?? 200, maxLimit);

      const sessionRows = await db.select().from(schema.sessions)
        .where(eq(schema.sessions.id, sessionId))
        .limit(1);
      const r = requireEntity(sessionRows, sessionId, "Session");
      if (!r.ok) return r.error;

      const rows = await db.select().from(schema.sessionMessages)
        .where(eq(schema.sessionMessages.sessionId, sessionId))
        .orderBy(schema.sessionMessages.id);

      // Take the last N messages
      const messages = rows.slice(-effectiveLimit).map(row => ({
        type: row.type,
        data: row.data ? stripAnsi(row.data) : undefined,
        exitCode: row.exitCode != null ? Number(row.exitCode) : undefined,
      }));

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            sessionId,
            totalMessages: rows.length,
            returned: messages.length,
            sessionStatus: r.value.status,
            messages,
          }, null, 2),
        }],
      };
    },
  );
}
