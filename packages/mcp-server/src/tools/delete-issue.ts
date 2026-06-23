import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { requireEntity } from "../db-utils.js";
import { prodDeps, type ToolDeps } from "./deps.js";
import { deleteIssueCascade } from "@agentic-kanban/shared/lib/cascade-delete";

export function registerDeleteIssue(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema, notifyBoard } = deps;
  server.tool(
    "delete_issue",
    "Delete an issue and all its associated data",
    {
      issueId: z.string().describe("The issue ID to delete"),
    },
    async ({ issueId }) => {
      const existingRows = await db.select({ projectId: schema.issues.projectId })
        .from(schema.issues)
        .where(eq(schema.issues.id, issueId))
        .limit(1);
      const r = requireEntity(existingRows, issueId, "Issue");
      if (!r.ok) return r.error;

      const projectId = r.value.projectId;

      await deleteIssueCascade(issueId, db);

      notifyBoard(projectId, "mcp_delete_issue");

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ id: issueId, deleted: true }, null, 2) }],
      };
    },
  );
}
