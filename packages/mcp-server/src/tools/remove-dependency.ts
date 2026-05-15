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
      issueId: z.string().describe("The issue ID that has the dependency"),
      dependsOnId: z.string().describe("The issue ID of the prerequisite to remove"),
    },
    async ({ issueId, dependsOnId }) => {
      await db.delete(schema.issueDependencies)
        .where(and(
          eq(schema.issueDependencies.issueId, issueId),
          eq(schema.issueDependencies.dependsOnId, dependsOnId),
        ));

      const rows = await db.select({ projectId: schema.issues.projectId }).from(schema.issues).where(eq(schema.issues.id, issueId)).limit(1);
      if (rows.length > 0) {
        notifyBoard(rows[0].projectId, "mcp_dependency_removed");
      }

      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true }, null, 2) }] };
    },
  );
}
