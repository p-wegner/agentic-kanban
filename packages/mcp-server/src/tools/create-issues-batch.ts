import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { prodDeps, type ToolDeps } from "./deps.js";

const issueInputSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  issueType: z.string().optional(),
  estimate: z.string().nullable().optional(),
  sortOrder: z.number().optional(),
  statusName: z.string().optional(),
});

export function registerCreateIssuesBatch(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema, notifyBoard } = deps;
  server.tool(
    "create_issues_batch",
    "Create multiple issues atomically in a single call. Returns each created issue with its assigned issueNumber. All-or-nothing: any validation failure rolls back.",
    {
      projectId: z.string().optional().describe("Project ID (defaults to active project)"),
      issues: z.array(issueInputSchema).describe("Array of issue payloads"),
    },
    async ({ projectId, issues }) => {
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

      const statuses = await db.select().from(schema.projectStatuses)
        .where(eq(schema.projectStatuses.projectId, pid))
        .orderBy(schema.projectStatuses.sortOrder);
      if (statuses.length === 0) {
        return { content: [{ type: "text" as const, text: "No statuses configured for project" }] };
      }

      for (let i = 0; i < issues.length; i++) {
        if (!issues[i].title?.trim()) {
          return { content: [{ type: "text" as const, text: `Error: issues[${i}].title is required` }] };
        }
        if (issues[i].statusName && !statuses.find(s => s.name === issues[i].statusName)) {
          return { content: [{ type: "text" as const, text: `Error: issues[${i}].statusName '${issues[i].statusName}' not found` }] };
        }
      }

      const maxResult = await db
        .select({ maxNum: sql<number | null>`max(${schema.issues.issueNumber})` })
        .from(schema.issues)
        .where(eq(schema.issues.projectId, pid));
      let nextNumber = (maxResult[0]?.maxNum ?? 0) + 1;

      const now = new Date().toISOString();
      const created: { id: string; issueNumber: number; title: string }[] = [];

      await db.transaction(async (tx) => {
        for (const input of issues) {
          const id = randomUUID();
          const statusId = input.statusName
            ? statuses.find(s => s.name === input.statusName)!.id
            : statuses[0].id;
          const issueNumber = nextNumber++;
          await tx.insert(schema.issues).values({
            id,
            issueNumber,
            title: input.title,
            description: input.description ?? null,
            priority: input.priority ?? "medium",
            issueType: input.issueType ?? "task",
            sortOrder: input.sortOrder ?? 0,
            estimate: input.estimate ?? null,
            statusId,
            projectId: pid!,
            createdAt: now,
            updatedAt: now,
          });
          created.push({ id, issueNumber, title: input.title });
        }
      });

      notifyBoard(pid, "mcp_create_issues_batch");

      return { content: [{ type: "text" as const, text: JSON.stringify({ issues: created }, null, 2) }] };
    },
  );
}
