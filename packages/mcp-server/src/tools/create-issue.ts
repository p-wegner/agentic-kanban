import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { prodDeps, type ToolDeps } from "./deps.js";
import { isIssueNumberUniqueConstraintError, resolveStatusByName, nextIssueNumber, resolveActiveProjectId } from "../db-utils.js";

const ISSUE_NUMBER_INSERT_ATTEMPTS = 3;

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
    },
    async ({ title, description, priority, projectId, statusName }) => {
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

      let id: string | null = null;
      let issueNumber: number | null = null;
      for (let attempt = 1; attempt <= ISSUE_NUMBER_INSERT_ATTEMPTS; attempt++) {
        issueNumber = await nextIssueNumber(db, schema, pid);
        id = randomUUID();
        const now = new Date().toISOString();

        try {
          await db.insert(schema.issues).values({
            id,
            issueNumber,
            title,
            description: description ?? null,
            priority: priority ?? "medium",
            sortOrder: 0,
            statusId,
            projectId: pid,
            createdAt: now,
            updatedAt: now,
          });
          break;
        } catch (err: unknown) {
          id = null;
          issueNumber = null;
          if (attempt < ISSUE_NUMBER_INSERT_ATTEMPTS && isIssueNumberUniqueConstraintError(err)) {
            continue;
          }
          throw err;
        }
      }

      if (id === null || issueNumber === null) {
        return { content: [{ type: "text" as const, text: "Error: could not allocate a unique issue number" }] };
      }

      notifyBoard(pid, "mcp_create_issue");

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ id, issueNumber, title, status: statusName || "Todo", priority: priority || "medium" }, null, 2) }],
      };
    },
  );
}
