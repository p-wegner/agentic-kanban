import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { prodDeps, type ToolDeps } from "./deps.js";
import { requireEntity, resolveStatusByName, checkOpenUnmergedWorkspace } from "../db-utils.js";
import { fireIssueStatusWebhook } from "@agentic-kanban/shared/lib/issue-status-orchestration";
import { isTerminalStatusName } from "@agentic-kanban/shared/lib";
import { transitionIssueStatus } from "@agentic-kanban/shared/lib/workflow-engine";

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
        if (isTerminalStatusName(statusName)) {
          const check = await checkOpenUnmergedWorkspace(db, schema, issueId);
          if (check.blocked) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  error: `Cannot set issue status to "${statusName}": it has an open workspace (branch: ${check.branch ?? check.workspaceId}) that has not been merged. Call merge_workspace first — it merges the branch and auto-transitions the issue to Done. To discard without merging, call close_workspace or delete_workspace first.`,
                  code: "OPEN_WORKSPACE_NOT_MERGED",
                  workspaceId: check.workspaceId,
                  branch: check.branch,
                }),
              }],
            };
          }
        }
        const r = await resolveStatusByName(db, schema, existing.projectId, statusName);
        if (!r.ok) return r.error;
        // #501: statusId/statusChangedAt deliberately NOT added to `updates` — the status
        // write goes through transitionIssueStatus below so the workflow current-node is
        // synced with it. Writing it here as a plain column left `currentNodeId` on a
        // non-end node and dependency resolution then silently failed (#537).
        resolvedStatusId = r.statusId;
      }

      // Non-status fields first; `updates` always carries at least `updatedAt`.
      await db.update(schema.issues).set(updates).where(eq(schema.issues.id, issueId));

      if (resolvedStatusId) {
        await transitionIssueStatus(db, issueId, resolvedStatusId, { now });
      }

      notifyBoard(existing.projectId, "mcp_update_issue");

      // Fire outbound webhook if a status change occurred and a URL is configured.
      // Pref lookup + validation + fire live in the shared orchestration seam
      // (#974), shared with move_issue and the server webhook sender.
      if (resolvedStatusId && statusName) {
        await fireIssueStatusWebhook(db, {
          issueId,
          issueNumber: existing.issueNumber,
          title: title ?? existing.title,
          projectId: existing.projectId,
          newStatusId: resolvedStatusId,
          newStatusName: statusName,
          statusChangedAt: now,
        });
      }

      return {
        // #501 moved the status write out of `updates`, so "statusId" is re-added here
        // explicitly. Deriving the response purely from the object's keys would have
        // silently dropped it from the reported field list — a response-contract change
        // that has nothing to do with the invariant being fixed.
        content: [{ type: "text" as const, text: JSON.stringify({
          id: issueId,
          updated: [
            ...Object.keys(updates).filter(k => k !== "updatedAt" && k !== "statusChangedAt"),
            ...(resolvedStatusId ? ["statusId"] : []),
          ],
        }, null, 2) }],
      };
    },
  );
}
