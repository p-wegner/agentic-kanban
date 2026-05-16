import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq, and } from "drizzle-orm";
import { notifyBoard } from "../notify.js";

export function registerRemoveDependency(server: McpServer) {
  server.tool(
    "remove_dependency",
    "Remove a dependency link between two issues",
    {
      dependencyId: z.string().describe("The dependency row ID to remove"),
    },
    async ({ dependencyId }) => {
      // Look up the dependency to find the project for notification
      const depRows = await db
        .select({ issueId: schema.issueDependencies.issueId })
        .from(schema.issueDependencies)
        .where(eq(schema.issueDependencies.id, dependencyId))
        .limit(1);

      if (depRows.length === 0) {
        return { content: [{ type: "text" as const, text: "Error: Dependency not found" }] };
      }

      await db.delete(schema.issueDependencies)
        .where(eq(schema.issueDependencies.id, dependencyId));

      const rows = await db.select({ projectId: schema.issues.projectId }).from(schema.issues).where(eq(schema.issues.id, depRows[0].issueId)).limit(1);
      if (rows.length > 0) {
        notifyBoard(rows[0].projectId, "mcp_dependency_removed");
      }

      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true }, null, 2) }] };
    },
  );
}
