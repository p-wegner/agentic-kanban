import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { prodDeps, type ToolDeps } from "./deps.js";
import { notifyBoard } from "../notify.js";
import { mcpJson, requireEntity } from "../db-utils.js";

export function registerMarkReadyForMerge(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;

  server.tool(
    "mark_ready_for_merge",
    "Mark a workspace as reviewed and ready to merge. Call this after a successful code review with no critical or major issues. This flag allows future agents to merge the workspace without requiring another review.",
    {
      workspaceId: z.string().describe("The workspace ID to mark as ready for merge"),
    },
    async ({ workspaceId }) => {
      const wsRows = await db.select().from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1);
      const r = requireEntity(wsRows, workspaceId, "Workspace");
      if (!r.ok) return r.error;

      const issueRows = await db.select({ projectId: schema.issues.projectId })
        .from(schema.issues)
        .where(eq(schema.issues.id, r.value.issueId))
        .limit(1);
      const projectId = issueRows[0]?.projectId;

      const now = new Date().toISOString();
      await db.update(schema.workspaces)
        .set({ readyForMerge: true, updatedAt: now })
        .where(eq(schema.workspaces.id, workspaceId));

      if (projectId) notifyBoard(projectId, "workspace_ready_for_merge");

      return mcpJson({ id: workspaceId, readyForMerge: true });
    },
  );
}
