import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq, inArray } from "drizzle-orm";

export function registerListIssues(server: McpServer) {
  server.tool(
    "list_issues",
    "List all issues for a project, optionally filtered by status name, priority, or tag",
    {
      projectId: z.string().describe("The project ID"),
      status: z.string().optional().describe("Filter by status name (e.g., 'Todo', 'In Progress')"),
      priority: z.string().optional().describe("Filter by priority (low, medium, high, critical)"),
      tag: z.string().optional().describe("Filter by tag name (e.g., 'bug', 'feature')"),
    },
    async ({ projectId, status, priority, tag }) => {
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

      let results = await query;

      if (tag) {
        // Find all issue IDs that have the specified tag
        const matchingIssueIds = (await db
          .select({ issueId: schema.issueTags.issueId })
          .from(schema.issueTags)
          .innerJoin(schema.tags, eq(schema.issueTags.tagId, schema.tags.id))
          .where(eq(schema.tags.name, tag))
        ).map(r => r.issueId);

        const matchingSet = new Set(matchingIssueIds);
        results = results.filter(i => matchingSet.has(i.id));
      }

      if (status) {
        results = results.filter(i => i.statusName === status);
      }
      if (priority) {
        results = results.filter(i => i.priority === priority);
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
      };
    },
  );
}
