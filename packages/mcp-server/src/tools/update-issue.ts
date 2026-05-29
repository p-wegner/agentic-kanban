import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { prodDeps, type ToolDeps } from "./deps.js";
import { requireEntity, resolveStatusByName } from "../db-utils.js";

export function registerUpdateIssue(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema, notifyBoard } = deps;
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
      const existingResult = await db.select().from(schema.issues).where(eq(schema.issues.id, issueId)).limit(1);
      const r0 = requireEntity(existingResult, issueId, "Issue");
      if (!r0.ok) return r0.error;
      const existing = r0.value;

      const now = new Date().toISOString();
      const updates: Record<string, unknown> = { updatedAt: now };

      if (title !== undefined) updates.title = title;
      if (description !== undefined) updates.description = description;
      if (priority !== undefined) updates.priority = priority;
      if (issueType !== undefined) updates.issueType = issueType;
      if (estimate !== undefined) updates.estimate = estimate;

      if (statusName) {
        const r = await resolveStatusByName(db, schema, existing.projectId, statusName);
        if (!r.ok) return r.error;
        updates.statusId = r.statusId;
      }

      await db.update(schema.issues).set(updates).where(eq(schema.issues.id, issueId));

      notifyBoard(existing.projectId, "mcp_update_issue");

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ id: issueId, updated: Object.keys(updates).filter(k => k !== "updatedAt") }, null, 2) }],
      };
    },
  );
}
