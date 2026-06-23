import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { requireEntity } from "../db-utils.js";
import { prodDeps, type ToolDeps } from "./deps.js";
import { deleteWorkspaceCascade } from "@agentic-kanban/shared/lib/cascade-delete";

export function registerDeleteWorkspace(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema, notifyBoard } = deps;
  server.tool(
    "delete_workspace",
    "Delete a workspace and all its associated data",
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

      await deleteWorkspaceCascade(workspaceId, db);

      if (issueRows[0]?.projectId) {
        notifyBoard(issueRows[0].projectId, "mcp_delete_workspace");
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ id: workspaceId, deleted: true }, null, 2) }],
      };
    },
  );
}
