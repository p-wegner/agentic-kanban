import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";
import * as gitService from "../git-service.js";
import { notifyBoard } from "../notify.js";

export function registerCloseWorkspace(server: McpServer) {
  server.tool(
    "close_workspace",
    "Close a workspace without merging. For direct workspaces or abandoned work. Use merge_workspace instead if you want to merge the branch.",
    {
      workspaceId: z.string().describe("The workspace ID to close"),
    },
    async ({ workspaceId }) => {
      const wsRows = await db.select().from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1);
      if (wsRows.length === 0) {
        return { content: [{ type: "text" as const, text: `Workspace ${workspaceId} not found` }] };
      }

      const workspace = wsRows[0];

      // Resolve project for board notification
      const issueRows = await db.select({ projectId: schema.issues.projectId })
        .from(schema.issues)
        .where(eq(schema.issues.id, workspace.issueId))
        .limit(1);
      const projectId = issueRows[0]?.projectId;

      // Cleanup worktree if non-direct
      if (!workspace.isDirect && workspace.workingDir && projectId) {
        const projectRows = await db.select({ repoPath: schema.projects.repoPath })
          .from(schema.projects)
          .where(eq(schema.projects.id, projectId))
          .limit(1);
        if (projectRows[0]?.repoPath) {
          try { await gitService.removeWorktree(projectRows[0].repoPath, workspace.workingDir); } catch {}
        }
      }

      const now = new Date().toISOString();
      await db.update(schema.workspaces)
        .set({ status: "closed", workingDir: null, updatedAt: now })
        .where(eq(schema.workspaces.id, workspaceId));

      if (projectId) notifyBoard(projectId, "mcp_close_workspace");

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ id: workspaceId, status: "closed" }, null, 2) }],
      };
    },
  );
}
