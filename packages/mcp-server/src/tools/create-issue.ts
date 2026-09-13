import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { prodDeps, type ToolDeps } from "./deps.js";
import { mcpJson, nextIssueNumber, resolveActiveProjectId, resolveProjectName, resolveStatusByName, withUniqueIssueNumber } from "../db-utils.js";

export function registerCreateIssue(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema, notifyBoard } = deps;
  server.tool(
    "create_issue",
    "Create a new issue on the kanban board",
    {
      title: z.string().describe("Issue title"),
      description: z.string().optional().describe("Issue description"),
      priority: z.enum(["low", "medium", "high", "critical"]).optional().describe("Priority (default: medium)"),
      projectId: z.string().optional().describe("Project ID (defaults to active project)"),
      statusName: z.string().optional().describe("Status column name (default: 'Todo')"),
      // #1108: born-tagged, closing the race where a follow-up `POST /:id/tags` call
      // arrives after the monitor has already provisioned a workspace for this ticket —
      // mirrors `create_issues_batch`'s `tags` input.
      tags: z.array(z.string()).optional().describe("Tag names to assign to this issue (e.g. ['no-auto-start']). Unknown tags are created on the fly; matching is case-insensitive."),
      noAutoStart: z.boolean().optional().describe("Shorthand for tags: ['no-auto-start'] — keep the monitor from auto-starting or relaunching this ticket."),
    },
    async ({ title, description, priority, projectId, statusName, tags, noAutoStart }) => {
      const rpid = await resolveActiveProjectId(db, schema, projectId);
      if (!rpid.ok) return rpid.error;
      const pid = rpid.projectId;

      // Find status ID by name or default to first
      let statusId: string;
      if (statusName) {
        const r = await resolveStatusByName(db, schema, pid, statusName);
        if (!r.ok) return r.error;
        statusId = r.statusId;
      } else {
        const statuses = await db.select({ id: schema.projectStatuses.id })
          .from(schema.projectStatuses)
          .where(eq(schema.projectStatuses.projectId, pid))
          .orderBy(schema.projectStatuses.sortOrder)
          .limit(1);
        statusId = statuses[0].id;
      }

      const requestedTagNames = [...(tags ?? []), ...(noAutoStart ? ["no-auto-start"] : [])]
        .map((t) => t.trim())
        .filter(Boolean);

      const { id, issueNumber } = await withUniqueIssueNumber(
        () => nextIssueNumber(db, schema, pid),
        async (allocatedNumber) => {
          const newId = randomUUID();
          const now = new Date().toISOString();
          await db.insert(schema.issues).values({
            id: newId,
            issueNumber: allocatedNumber,
            title,
            description: description ?? null,
            priority: priority ?? "medium",
            sortOrder: 0,
            statusId,
            projectId: pid,
            createdAt: now,
            updatedAt: now,
          });
          // Tag resolution mirrors `create_issues_batch`: case-insensitive match against
          // an existing tag, else create it. Applied before this function returns, so the
          // issue is never observable (by the monitor or anything else) without its tags.
          //
          // Unlike the batch tool, this insert isn't wrapped in `db.transaction` (it runs
          // inside `withUniqueIssueNumber`'s retry, which only retries on an issue-number
          // collision) — so a failure here (e.g. SQLITE_BUSY under concurrent writers) must
          // not propagate and strand an already-inserted, untagged issue while reporting the
          // whole call as failed. Best-effort, same as `reposTouched` tagging server-side.
          try {
            const seenTagIds = new Set<string>();
            for (const tagName of new Set(requestedTagNames)) {
              const existing = await db.select({ id: schema.tags.id }).from(schema.tags)
                .where(sql`lower(${schema.tags.name}) = lower(${tagName})`).limit(1);
              let tagId: string;
              if (existing.length > 0) {
                tagId = existing[0].id;
              } else {
                tagId = randomUUID();
                await db.insert(schema.tags).values({ id: tagId, name: tagName, color: null, createdAt: now });
              }
              if (seenTagIds.has(tagId)) continue;
              seenTagIds.add(tagId);
              await db.insert(schema.issueTags).values({ id: randomUUID(), issueId: newId, tagId });
            }
          } catch { /* tagging is best-effort; the issue itself must still be returned as created */ }
          return { id: newId, issueNumber: allocatedNumber };
        },
      );

      notifyBoard(pid, "mcp_create_issue");

      // Echo the RESOLVED project (#335): `projectId` is optional and falls back to
      // the global mutable activeProjectId, so a caller that omitted it must be able
      // to see which board it actually wrote to.
      const projectName = await resolveProjectName(db, schema, pid);

      return mcpJson({ id, issueNumber, title, status: statusName || "Todo", priority: priority || "medium", projectId: pid, projectName });
    },
  );
}
