import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { notifyBoard } from "../notify.js";

export function registerCreateIssue(server: McpServer) {
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
      let pid = projectId;

      if (!pid) {
        const pref = await db
          .select({ value: schema.preferences.value })
          .from(schema.preferences)
          .where(eq(schema.preferences.key, "activeProjectId"))
          .limit(1);
        if (pref.length === 0 || !pref[0].value) {
          return { content: [{ type: "text" as const, text: "No active project. Run `pnpm cli -- register <path>` first." }] };
        }
        pid = pref[0].value;
      }

      // Find status ID by name or default to first
      const statuses = await db.select().from(schema.projectStatuses)
        .where(eq(schema.projectStatuses.projectId, pid))
        .orderBy(schema.projectStatuses.sortOrder);

      let statusId: string;
      if (statusName) {
        const found = statuses.find(s => s.name === statusName);
        if (!found) {
          return { content: [{ type: "text" as const, text: `Status '${statusName}' not found. Available: ${statuses.map(s => s.name).join(", ")}` }] };
        }
        statusId = found.id;
      } else {
        statusId = statuses[0].id;
      }

      const maxResult = await db
        .select({ maxNum: sql<number | null>`max(${schema.issues.issueNumber})` })
        .from(schema.issues)
        .where(eq(schema.issues.projectId, pid));
      const issueNumber = (maxResult[0]?.maxNum ?? 0) + 1;

      const id = randomUUID();
      const now = new Date().toISOString();

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

      notifyBoard(pid, "mcp_create_issue");

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ id, issueNumber, title, status: statusName || "Todo", priority: priority || "medium" }, null, 2) }],
      };
    },
  );
}
