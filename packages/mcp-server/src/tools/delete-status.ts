import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { prodDeps, type ToolDeps } from "./deps.js";
import { notifyBoard } from "../notify.js";
import { mcpJson, mcpText, requireEntity } from "../db-utils.js";

export function registerDeleteStatus(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;

  server.tool(
    "delete_status",
    "Delete a project status. Fails if any issues are linked to it.",
    {
      statusId: z.string().describe("The status ID to delete"),
    },
    async ({ statusId }) => {
      const existing = await db.select({ id: schema.projectStatuses.id, projectId: schema.projectStatuses.projectId, name: schema.projectStatuses.name })
        .from(schema.projectStatuses)
        .where(eq(schema.projectStatuses.id, statusId))
        .limit(1);
      const r = requireEntity(existing, statusId, "Status");
      if (!r.ok) return r.error;

      const projectId = r.value.projectId;

      const linkedIssues = await db.select({ id: schema.issues.id })
        .from(schema.issues)
        .where(eq(schema.issues.statusId, statusId))
        .limit(1);
      if (linkedIssues.length > 0) {
        return mcpText(`Cannot delete status "${r.value.name}" — it has linked issues. Move or delete those issues first.`);
      }

      await db.delete(schema.projectStatuses).where(eq(schema.projectStatuses.id, statusId));
      notifyBoard(projectId, "mcp_delete_status");

      return mcpJson({ id: statusId, name: r.value.name, deleted: true });
    },
  );
}
