import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { boardApi, boardErrorText, mcpJson, mcpText, mcpUnreachable } from "../board-call.js";
import { eq } from "drizzle-orm";
import { mcpStructuredError, workspaceClosedError, workspaceMissingWorkingDirError, workspaceNotFoundError } from "../db-utils.js";
import { prodDeps, type ToolDeps } from "./deps.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

export function registerRelaunchWorkspace(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema, notifyBoard } = deps;
  server.tool(
    "relaunch_workspace",
    "Relaunch an idle workspace by starting a new agent session. The workspace must be in 'idle' status.",
    {
      workspaceId: z.string().describe("The workspace ID to relaunch"),
      prompt: z.string().describe("The prompt to send to the agent"),
    },
    async ({ workspaceId, prompt }) => {
      const wsRows = await db.select().from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1);
      if (wsRows.length === 0) return workspaceNotFoundError(workspaceId);

      const workspace = wsRows[0];
      if (workspace.status === "closed") return workspaceClosedError(workspaceId);
      if (!workspace.workingDir?.trim()) return workspaceMissingWorkingDirError(workspaceId);
      if (workspace.status !== "idle") {
        return mcpStructuredError("WORKSPACE_NOT_IDLE", "Workspace must be idle before relaunch", {
          workspaceId,
          status: workspace.status,
        });
      }

      try {
        const { ok, statusText, data: raw } = await boardApi(`/api/workspaces/${workspaceId}/launch`, {
          method: "POST",
          body: JSON.stringify({ prompt }),
        });
        const data = (raw ?? {}) as { sessionId?: string };

        if (!ok) {
          return mcpText(`Launch failed: ${boardErrorText(raw, statusText)}`);
        }

        // Resolve projectId for board notification
        const issueRows = await db.select({ projectId: schema.issues.projectId })
          .from(schema.issues)
          .where(eq(schema.issues.id, workspace.issueId))
          .limit(1);
        if (issueRows[0]?.projectId) {
          notifyBoard(issueRows[0].projectId, "mcp_relaunch_workspace");
        }

        return mcpJson({ id: workspaceId, sessionId: data.sessionId });
      } catch (err) {
        return mcpText(`Launch failed: ${errorMessage(err)}`);
      }
    },
  );
}
