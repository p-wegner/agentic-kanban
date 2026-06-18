import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq, ne } from "drizzle-orm";
import { prodDeps, type ToolDeps } from "./deps.js";
import { requireEntity, resolveStatusByName } from "../db-utils.js";
import { validateWebhookUrl, fireWebhook, buildIssueStatusPayload } from "@agentic-kanban/shared/lib";

const TERMINAL_STATUSES = new Set(["Done", "Cancelled"]);

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

      let resolvedStatusId: string | null = null;
      if (statusName) {
        // Guard: block terminal-status moves when the issue has an open non-direct
        // workspace. Direct workspaces (isDirect=true) commit directly to master —
        // no branch to merge — so they are excluded from this check.
        if (TERMINAL_STATUSES.has(statusName)) {
          const openWs = await db
            .select({ id: schema.workspaces.id, branch: schema.workspaces.branch })
            .from(schema.workspaces)
            .where(and(
              eq(schema.workspaces.issueId, issueId),
              ne(schema.workspaces.status, "closed"),
              eq(schema.workspaces.isDirect, false),
            ))
            .limit(1);
          if (openWs.length > 0) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  error: `Cannot set issue status to "${statusName}": it has an open workspace (branch: ${openWs[0].branch ?? openWs[0].id}) that has not been merged. Call merge_workspace first — it merges the branch and auto-transitions the issue to Done. To discard without merging, call close_workspace or delete_workspace first.`,
                  code: "OPEN_WORKSPACE_NOT_MERGED",
                  workspaceId: openWs[0].id,
                  branch: openWs[0].branch,
                }),
              }],
            };
          }
        }
        const r = await resolveStatusByName(db, schema, existing.projectId, statusName);
        if (!r.ok) return r.error;
        updates.statusId = r.statusId;
        updates.statusChangedAt = now;
        resolvedStatusId = r.statusId;
      }

      await db.update(schema.issues).set(updates).where(eq(schema.issues.id, issueId));

      notifyBoard(existing.projectId, "mcp_update_issue");

      // Fire outbound webhook if a status change occurred and a URL is configured
      if (resolvedStatusId && statusName) {
        const webhookPref = await db
          .select({ value: schema.preferences.value })
          .from(schema.preferences)
          .where(eq(schema.preferences.key, `outbound_webhook_url_${existing.projectId}`))
          .limit(1)
          .then((rows) => rows[0]?.value ?? null)
          .catch(() => null);
        const webhookUrl = validateWebhookUrl(webhookPref);
        if (webhookUrl) {
          fireWebhook(webhookUrl, buildIssueStatusPayload({
            issueId,
            issueNumber: existing.issueNumber,
            title: title ?? existing.title,
            projectId: existing.projectId,
            newStatusId: resolvedStatusId,
            newStatusName: statusName,
            statusChangedAt: now,
          }));
        }
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ id: issueId, updated: Object.keys(updates).filter(k => k !== "updatedAt" && k !== "statusChangedAt") }, null, 2) }],
      };
    },
  );
}
