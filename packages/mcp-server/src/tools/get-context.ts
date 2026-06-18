import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";
import { requireEntity, resolveActiveProjectId } from "../db-utils.js";

export function registerGetContext(server: McpServer) {
  server.tool(
    "get_context",
    "Get current project context including project info, issues count by status, and active workspaces",
    {
      projectId: z.string().optional().describe("Project ID (defaults to active project)"),
    },
    async ({ projectId }) => {
      const rpid = await resolveActiveProjectId(db, schema, projectId);
      if (!rpid.ok) return rpid.error;
      const pid = rpid.projectId;

      const project = await db.select().from(schema.projects).where(eq(schema.projects.id, pid)).limit(1);
      const rp = requireEntity(project, pid, "Project");
      if (!rp.ok) return rp.error;

      const statuses = await db.select().from(schema.projectStatuses)
        .where(eq(schema.projectStatuses.projectId, pid))
        .orderBy(schema.projectStatuses.sortOrder);

      const issues = await db.select({
        statusId: schema.issues.statusId,
        statusName: schema.projectStatuses.name,
      })
        .from(schema.issues)
        .innerJoin(schema.projectStatuses, eq(schema.issues.statusId, schema.projectStatuses.id))
        .where(eq(schema.issues.projectId, pid));

      const workspaces = await db.select().from(schema.workspaces)
        .where(eq(schema.workspaces.status, "active"));

      const issuesByStatus: Record<string, number> = {};
      for (const issue of issues) {
        issuesByStatus[issue.statusName] = (issuesByStatus[issue.statusName] || 0) + 1;
      }

      const context = {
        project: rp.value,
        statuses: statuses.map(s => s.name),
        issueCounts: issuesByStatus,
        totalIssues: issues.length,
        activeWorkspaces: workspaces.length,
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(context, null, 2) }] };
    },
  );
}
