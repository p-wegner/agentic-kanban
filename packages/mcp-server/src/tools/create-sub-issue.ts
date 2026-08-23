import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { prodDeps, type ToolDeps } from "./deps.js";
import { mcpError, mcpText, nextIssueNumber, resolveStatusByName, withUniqueIssueNumber } from "../db-utils.js";
import { ISSUE_TYPES } from "@agentic-kanban/shared";

export function registerCreateSubIssue(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema, notifyBoard } = deps;

  server.tool(
    "create_sub_issue",
    "Create one child issue and link it to a parent with a child_of dependency in the same transaction.",
    {
      parentIssueId: z.string().describe("Parent issue ID"),
      title: z.string().describe("Child issue title"),
      description: z.string().optional().describe("Child issue description"),
      priority: z.enum(["low", "medium", "high", "critical"]).optional().describe("Priority (default: medium)"),
      issueType: z.enum(ISSUE_TYPES).optional().describe("Issue type (default: task)"),
      estimate: z.string().nullable().optional().describe("Optional estimate"),
      sortOrder: z.number().optional().describe("Sort order within the status column"),
      statusName: z.string().optional().describe("Status column name (default: first status in parent project)"),
    },
    async ({ parentIssueId, title, description, priority, issueType, estimate, sortOrder, statusName }) => {

      if (!title.trim()) return mcpError("Error: title is required");

      const parents = await db
        .select({ projectId: schema.issues.projectId, issueNumber: schema.issues.issueNumber, title: schema.issues.title })
        .from(schema.issues)
        .where(eq(schema.issues.id, parentIssueId))
        .limit(1);
      const parent = parents[0];
      if (!parent) return mcpError(`Error: parent issue not found: ${parentIssueId}`);

      let statusId: string;
      if (statusName) {
        const resolved = await resolveStatusByName(db, schema, parent.projectId, statusName);
        if (!resolved.ok) return resolved.error;
        statusId = resolved.statusId;
      } else {
        const statuses = await db
          .select({ id: schema.projectStatuses.id })
          .from(schema.projectStatuses)
          .where(eq(schema.projectStatuses.projectId, parent.projectId))
          .orderBy(schema.projectStatuses.sortOrder)
          .limit(1);
        if (statuses.length === 0) return mcpError("Error: no statuses configured for parent project");
        statusId = statuses[0].id;
      }

      const { id, dependencyId, issueNumber } = await withUniqueIssueNumber(
        () => nextIssueNumber(db, schema, parent.projectId),
        async (allocatedNumber) => {
          const now = new Date().toISOString();
          const newId = randomUUID();
          const newDependencyId = randomUUID();
          await db.transaction(async (tx) => {
            await tx.insert(schema.issues).values({
              id: newId,
              issueNumber: allocatedNumber,
              title,
              description: description ?? null,
              priority: priority ?? "medium",
              issueType: issueType ?? "task",
              estimate: estimate ?? null,
              sortOrder: sortOrder ?? 0,
              statusId,
              projectId: parent.projectId,
              createdAt: now,
              updatedAt: now,
            });
            await tx.insert(schema.issueDependencies).values({
              id: newDependencyId,
              issueId: newId,
              dependsOnId: parentIssueId,
              type: "child_of",
              createdAt: now,
            });
          });
          return { id: newId, dependencyId: newDependencyId, issueNumber: allocatedNumber };
        },
      );

      notifyBoard(parent.projectId, "mcp_create_sub_issue");
      notifyBoard(parent.projectId, "mcp_dependency_added");

      return mcpText(JSON.stringify({
        id,
        issueNumber,
        title,
        parentIssueId,
        parentIssueNumber: parent.issueNumber,
        dependencyId,
        dependencyType: "child_of",
        status: statusName ?? "default",
        priority: priority ?? "medium",
      }, null, 2));
    },
  );
}
