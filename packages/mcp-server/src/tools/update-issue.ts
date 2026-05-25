import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";
import { notifyBoard } from "../notify.js";

export function registerUpdateIssue(server: McpServer) {
  server.tool(
    "update_issue",
    "Update an existing issue (title, description, status, priority, type)",
    {
      issueId: z.string().describe("The issue ID to update"),
      title: z.string().optional().describe("New title"),
      description: z.string().optional().describe("New description"),
      statusName: z.string().optional().describe("Move to status column by name (e.g., 'In Progress', 'Done')"),
      priority: z.enum(["low", "medium", "high", "critical"]).optional().describe("New priority"),
      issueType: z.enum(["task", "bug", "feature", "chore"]).optional().describe("Issue type (task, bug, feature, chore)"),
      estimate: z.enum(["XS", "S", "M", "L", "XL"]).nullable().optional().describe("Size estimate (XS/S/M/L/XL), or null to clear"),
    },
    async ({ issueId, title, description, statusName, priority, issueType, estimate }) => {
      const existing = await db.select().from(schema.issues).where(eq(schema.issues.id, issueId)).limit(1);
      if (existing.length === 0) {
        return { content: [{ type: "text" as const, text: `Issue ${issueId} not found` }] };
      }

      const now = new Date().toISOString();
      const updates: Record<string, unknown> = { updatedAt: now };

      if (title !== undefined) updates.title = title;
      if (description !== undefined) updates.description = description;
      if (priority !== undefined) updates.priority = priority;
      if (issueType !== undefined) updates.issueType = issueType;
      if (estimate !== undefined) updates.estimate = estimate;

      if (statusName) {
        const statuses = await db.select().from(schema.projectStatuses)
          .where(eq(schema.projectStatuses.projectId, existing[0].projectId));
        const found = statuses.find(s => s.name === statusName);
        if (!found) {
          return { content: [{ type: "text" as const, text: `Status '${statusName}' not found. Available: ${statuses.map(s => s.name).join(", ")}` }] };
        }
        updates.statusId = found.id;
      }

      await db.update(schema.issues).set(updates).where(eq(schema.issues.id, issueId));

      notifyBoard(existing[0].projectId, "mcp_update_issue");

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ id: issueId, updated: Object.keys(updates).filter(k => k !== "updatedAt") }, null, 2) }],
      };
    },
  );
}
