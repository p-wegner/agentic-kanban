import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { prodDeps, type ToolDeps } from "./deps.js";
import { mcpJson, mcpStructuredError, requireEntity, resolveStatusByName, checkOpenUnmergedWorkspace } from "../db-utils.js";
import { fireIssueStatusWebhook } from "@agentic-kanban/shared/lib/issue-status-orchestration";
import { isTerminalStatusName } from "@agentic-kanban/shared/lib";
import { transitionIssueStatus } from "@agentic-kanban/shared/lib/workflow-engine";
import { ISSUE_TYPES, ISSUE_ESTIMATES } from "@agentic-kanban/shared";

export function registerUpdateIssue(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema, notifyBoard } = deps;
  server.tool(
    "update_issue",
    "Update an existing issue (title, description, status, priority, type, estimate, tags). tags.add / tags.remove take tag NAMES; an added tag is created when the board has none of that name (e.g. 'harness').",
    {
      issueId: z.string().describe("The issue ID to update"),
      title: z.string().optional().describe("New title"),
      description: z.string().optional().describe("New description"),
      statusName: z.string().optional().describe("Move to status column by name (e.g., 'In Progress', 'Done')"),
      priority: z.enum(["low", "medium", "high", "critical"]).optional().describe("New priority"),
      issueType: z.enum(ISSUE_TYPES).optional().describe("Issue type (task, bug, feature, chore)"),
      estimate: z.enum(ISSUE_ESTIMATES).nullable().optional().describe("Size estimate (XS/S/M/L/XL), or null to clear"),
      tags: z.object({
        add: z.array(z.string().min(1)).optional().describe("Tag names to add (created if the board has no tag of that name; already-present tags are left alone)"),
        remove: z.array(z.string().min(1)).optional().describe("Tag names to remove (a name the issue does not carry is a no-op)"),
      }).optional().describe("Tag changes by NAME, e.g. { add: ['harness'] } — #1032: the REST tag routes need a tag id, this does not"),
    },
    async ({ issueId, title, description, statusName, priority, issueType, estimate, tags }) => {
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
            return mcpStructuredError(
              "OPEN_WORKSPACE_NOT_MERGED",
              `Cannot set issue status to "${statusName}": it has an open workspace (branch: ${check.branch ?? check.workspaceId}) that has not been merged. Call merge_workspace first — it merges the branch and auto-transitions the issue to Done. To discard without merging, call close_workspace or delete_workspace first.`,
              { workspaceId: check.workspaceId, branch: check.branch },
            );
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

      const tagsChanged = await applyTagChanges(db, schema, issueId, tags, now);

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

      // #501 moved the status write out of `updates`, so "statusId" is re-added here
      // explicitly. Deriving the response purely from the object's keys would have
      // silently dropped it from the reported field list — a response-contract change
      // that has nothing to do with the invariant being fixed.
      return mcpJson({
        id: issueId,
        updated: [
          ...Object.keys(updates).filter(k => k !== "updatedAt" && k !== "statusChangedAt"),
          ...(resolvedStatusId ? ["statusId"] : []),
          ...(tagsChanged ? ["tags"] : []),
        ],
      });
    },
  );
}

/**
 * #1032 — tag changes by NAME. Add is idempotent (a tag the issue already carries is not
 * duplicated) and creates a missing tag, so an MCP-only agent can set `harness` without
 * first round-tripping `list_tags`/`create_tag` and the REST `POST /api/issues/:id/tags`.
 * Remove by name; a name the issue does not carry is a no-op. Returns whether anything
 * was written so the response's `updated` list only names `tags` when it is true.
 */
async function applyTagChanges(
  db: ToolDeps["db"],
  schema: ToolDeps["schema"],
  issueId: string,
  tags: { add?: string[]; remove?: string[] } | undefined,
  now: string,
): Promise<boolean> {
  const add = [...new Set((tags?.add ?? []).map((n) => n.trim()).filter(Boolean))];
  const remove = [...new Set((tags?.remove ?? []).map((n) => n.trim()).filter(Boolean))];
  if (add.length === 0 && remove.length === 0) return false;

  const names = [...new Set([...add, ...remove])];
  const known = await db.select({ id: schema.tags.id, name: schema.tags.name })
    .from(schema.tags).where(inArray(schema.tags.name, names));
  const idByName = new Map(known.map((t) => [t.name, t.id]));

  const current = await db.select({ tagId: schema.issueTags.tagId })
    .from(schema.issueTags).where(eq(schema.issueTags.issueId, issueId));
  const currentIds = new Set(current.map((r) => r.tagId));

  let changed = false;
  for (const name of add) {
    let tagId = idByName.get(name);
    if (!tagId) {
      tagId = randomUUID();
      await db.insert(schema.tags).values({ id: tagId, name, color: null, createdAt: now });
      idByName.set(name, tagId);
    }
    if (currentIds.has(tagId)) continue;
    await db.insert(schema.issueTags).values({ id: randomUUID(), issueId, tagId });
    currentIds.add(tagId);
    changed = true;
  }
  const removeIds = remove.map((n) => idByName.get(n)).filter((id): id is string => !!id && currentIds.has(id));
  if (removeIds.length > 0) {
    await db.delete(schema.issueTags)
      .where(and(eq(schema.issueTags.issueId, issueId), inArray(schema.issueTags.tagId, removeIds)));
    changed = true;
  }
  return changed;
}
