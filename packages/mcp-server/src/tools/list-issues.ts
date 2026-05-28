import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, inArray, and } from "drizzle-orm";
import { prodDeps, type ToolDeps } from "./deps.js";

export function registerListIssues(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;
  server.tool(
    "list_issues",
    "List all issues for a project, optionally filtered by status name, priority, tag, blocked status, or issue number",
    {
      projectId: z.string().describe("The project ID"),
      status: z.string().optional().describe("Filter by status name (e.g., 'Todo', 'In Progress')"),
      priority: z.string().optional().describe("Filter by priority (low, medium, high, critical)"),
      tag: z.string().optional().describe("Filter by tag name (e.g., 'bug', 'feature')"),
      blocked: z.boolean().optional().describe("Filter by blocked status (true = only blocked, false = only unblocked)"),
      issueNumber: z.number().optional().describe("Filter by issue number (e.g., 42)"),
    },
    async ({ projectId, status, priority, tag, blocked, issueNumber }) => {
      let query = db.select({
        id: schema.issues.id,
        issueNumber: schema.issues.issueNumber,
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
        .where(issueNumber !== undefined
          ? and(eq(schema.issues.projectId, projectId), eq(schema.issues.issueNumber, issueNumber))
          : eq(schema.issues.projectId, projectId));

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

      if (blocked !== undefined) {
        const issueIds = results.map(i => i.id);
        const depRows = issueIds.length > 0 ? await db
          .select({ issueId: schema.issueDependencies.issueId, dependsOnId: schema.issueDependencies.dependsOnId, type: schema.issueDependencies.type })
          .from(schema.issueDependencies)
          .where(inArray(schema.issueDependencies.issueId, issueIds)) : [];

        const dependsOnIds = [...new Set(depRows.map(d => d.dependsOnId))];
        const depStatusMap = new Map<string, string>();
        if (dependsOnIds.length > 0) {
          const depStatuses = await db
            .select({ id: schema.issues.id, statusName: schema.projectStatuses.name })
            .from(schema.issues)
            .innerJoin(schema.projectStatuses, eq(schema.issues.statusId, schema.projectStatuses.id))
            .where(inArray(schema.issues.id, dependsOnIds));
          for (const ds of depStatuses) depStatusMap.set(ds.id, ds.statusName);
        }

        const blockedSet = new Set<string>();
        for (const dep of depRows) {
          const isBlockingType = dep.type === "depends_on" || dep.type === "blocked_by";
          if (isBlockingType && depStatusMap.get(dep.dependsOnId) !== "Done" && depStatusMap.get(dep.dependsOnId) !== "AI Reviewed") {
            blockedSet.add(dep.issueId);
          }
        }

        results = results.filter(i => blocked ? blockedSet.has(i.id) : !blockedSet.has(i.id));
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
      };
    },
  );
}
