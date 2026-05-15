import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";

export function registerGetIssue(server: McpServer) {
  server.tool(
    "get_issue",
    "Get detailed information about a specific issue, including workspaces and dependencies",
    {
      issueId: z.string().describe("The issue ID"),
    },
    async ({ issueId }) => {
      const issues = await db.select({
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
        .where(eq(schema.issues.id, issueId))
        .limit(1);

      if (issues.length === 0) {
        return { content: [{ type: "text" as const, text: `Issue ${issueId} not found` }] };
      }

      const [workspaces, dependsOn, blockedBy] = await Promise.all([
        db.select().from(schema.workspaces).where(eq(schema.workspaces.issueId, issueId)),
        db.select({
          id: schema.issueDependencies.id,
          dependsOnId: schema.issueDependencies.dependsOnId,
          createdAt: schema.issueDependencies.createdAt,
          issueTitle: schema.issues.title,
          issueStatusName: schema.projectStatuses.name,
          issueNumber: schema.issues.issueNumber,
        })
          .from(schema.issueDependencies)
          .innerJoin(schema.issues, eq(schema.issueDependencies.dependsOnId, schema.issues.id))
          .innerJoin(schema.projectStatuses, eq(schema.issues.statusId, schema.projectStatuses.id))
          .where(eq(schema.issueDependencies.issueId, issueId)),
        db.select({
          id: schema.issueDependencies.id,
          issueId: schema.issueDependencies.issueId,
          createdAt: schema.issueDependencies.createdAt,
          issueTitle: schema.issues.title,
          issueStatusName: schema.projectStatuses.name,
          issueNumber: schema.issues.issueNumber,
        })
          .from(schema.issueDependencies)
          .innerJoin(schema.issues, eq(schema.issueDependencies.issueId, schema.issues.id))
          .innerJoin(schema.projectStatuses, eq(schema.issues.statusId, schema.projectStatuses.id))
          .where(eq(schema.issueDependencies.dependsOnId, issueId)),
      ]);

      const isBlocked = dependsOn.some((dep) => dep.issueStatusName !== "Done");

      const result = {
        ...issues[0],
        workspaces,
        dependencies: { dependsOn, blockedBy },
        isBlocked,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
