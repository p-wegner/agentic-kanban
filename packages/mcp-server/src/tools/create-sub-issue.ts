import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { prodDeps, type ToolDeps } from "./deps.js";
import { nextIssueNumber, resolveStatusByName } from "../db-utils.js";

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
      issueType: z.string().optional().describe("Issue type (default: task)"),
      estimate: z.string().nullable().optional().describe("Optional estimate"),
      sortOrder: z.number().optional().describe("Sort order within the status column"),
      statusName: z.string().optional().describe("Status column name (default: first status in parent project)"),
    },
    async ({ parentIssueId, title, description, priority, issueType, estimate, sortOrder, statusName }) => {
      const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

      if (!title.trim()) return text("Error: title is required");

      const parents = await db
        .select({ projectId: schema.issues.projectId, issueNumber: schema.issues.issueNumber, title: schema.issues.title })
        .from(schema.issues)
        .where(eq(schema.issues.id, parentIssueId))
        .limit(1);
      const parent = parents[0];
      if (!parent) return text(`Error: parent issue not found: ${parentIssueId}`);

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
        if (statuses.length === 0) return text("Error: no statuses configured for parent project");
        statusId = statuses[0].id;
      }

      const now = new Date().toISOString();
      const id = randomUUID();
      const dependencyId = randomUUID();
      const issueNumber = await nextIssueNumber(db, schema, parent.projectId);

      await db.transaction(async (tx) => {
        await tx.insert(schema.issues).values({
          id,
          issueNumber,
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
          id: dependencyId,
          issueId: id,
          dependsOnId: parentIssueId,
          type: "child_of",
          createdAt: now,
        });
      });

      notifyBoard(parent.projectId, "mcp_create_sub_issue");
      notifyBoard(parent.projectId, "mcp_dependency_added");

      return text(JSON.stringify({
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
