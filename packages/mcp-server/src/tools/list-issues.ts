import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";

export function registerListIssues(server: McpServer) {
  server.tool(
    "list_issues",
    "List all issues for a project, optionally filtered by status name",
    {
      projectId: z.string().describe("The project ID"),
      status: z.string().optional().describe("Filter by status name (e.g., 'Todo', 'In Progress')"),
      priority: z.string().optional().describe("Filter by priority (low, medium, high, critical)"),
    },
    async ({ projectId, status, priority }) => {
      let query = db.select({
        id: schema.issues.id,
        title: schema.issues.title,
        description: schema.issues.description,
        priority: schema.issues.priority,
        sortOrder: schema.issues.sortOrder,
        statusId: schema.issues.statusId,
        projectId: schema.issues.projectId,
        createdAt: schema.issues.createdAt,
        updatedAt: schema.issues.updatedAt,
        statusName: schema.projectStatuses.name,
      })
        .from(schema.issues)
        .innerJoin(schema.projectStatuses, eq(schema.issues.statusId, schema.projectStatuses.id))
        .where(eq(schema.issues.projectId, projectId));

      const results = await query;

      let filtered = results;
      if (status) {
        filtered = filtered.filter(i => i.statusName === status);
      }
      if (priority) {
        filtered = filtered.filter(i => i.priority === priority);
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(filtered, null, 2) }],
      };
    },
  );
}
