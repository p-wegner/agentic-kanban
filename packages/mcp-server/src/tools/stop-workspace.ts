import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";
import { notifyBoard } from "../notify.js";
import { requireEntity } from "../db-utils.js";

export function registerStopWorkspace(server: McpServer) {
  server.tool(
    "stop_workspace",
    "Stop any running agent session for a workspace",
    {
      workspaceId: z.string().describe("The workspace ID to stop"),
    },
    async ({ workspaceId }) => {
      const wsRows = await db.select().from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1);
      const r = requireEntity(wsRows, workspaceId, "Workspace");
      if (!r.ok) return r.error;

      // Find running sessions for this workspace
      const runningSessions = await db.select().from(schema.sessions)
        .where(eq(schema.sessions.workspaceId, workspaceId));

      const running = runningSessions.filter(s => s.status === "running");

      // Stop each running session by updating DB status
      // (MCP server doesn't have access to the process manager, so we update DB directly)
      const now = new Date().toISOString();
      for (const session of running) {
        await db.update(schema.sessions)
          .set({ status: "stopped", exitCode: "0", endedAt: now })
          .where(eq(schema.sessions.id, session.id));
      }

      await db.update(schema.workspaces)
        .set({ status: "idle", updatedAt: now })
        .where(eq(schema.workspaces.id, workspaceId));

      // Resolve projectId for board notification
      const issueRows = await db.select({ projectId: schema.issues.projectId })
        .from(schema.issues)
        .where(eq(schema.issues.id, r.value.issueId))
        .limit(1);
      if (issueRows[0]?.projectId) {
        notifyBoard(issueRows[0].projectId, "mcp_stop_workspace");
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ id: workspaceId, stopped: running.length > 0, sessionsStopped: running.length }, null, 2),
        }],
      };
    },
  );
}
