import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, and, isNotNull } from "drizzle-orm";
import { prodDeps, type ToolDeps } from "./deps.js";

export function registerCleanupProject(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;
  server.tool(
    "cleanup_project",
    "Report stale git worktrees for closed/merged workspaces in a project. Lists workspace branches and their worktree paths so they can be removed manually with 'git worktree remove --force <path>'. This tool does NOT auto-remove worktrees — it only reports them. Omit projectId to scan all projects.",
    {
      projectId: z.string().optional().describe("Project ID to inspect (defaults to all projects)"),
    },
    async ({ projectId }) => {
      try {
        // Query closed workspaces that still have a workingDir set
        const query = db
          .select({
            id: schema.workspaces.id,
            branch: schema.workspaces.branch,
            workingDir: schema.workspaces.workingDir,
            status: schema.workspaces.status,
            updatedAt: schema.workspaces.updatedAt,
            issueId: schema.workspaces.issueId,
          })
          .from(schema.workspaces)
          .where(
            and(
              eq(schema.workspaces.status, "closed"),
              isNotNull(schema.workspaces.workingDir),
            ),
          );

        let closedWorkspaces = await query;

        // If a specific project was requested, filter by its issues
        if (projectId) {
          const issueRows = await db
            .select({ id: schema.issues.id })
            .from(schema.issues)
            .where(eq(schema.issues.projectId, projectId));
          const issueIds = new Set(issueRows.map((i) => i.id));
          closedWorkspaces = closedWorkspaces.filter((ws) => issueIds.has(ws.issueId));
        }

        const withWorktrees = closedWorkspaces.filter((ws) => ws.workingDir);

        if (withWorktrees.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                staleWorktrees: [],
                message: "No stale worktrees found.",
              }, null, 2),
            }],
          };
        }

        const staleWorktrees = withWorktrees.map((ws) => ({
          workspaceId: ws.id,
          branch: ws.branch,
          workingDir: ws.workingDir,
          status: ws.status,
          updatedAt: ws.updatedAt,
          removeCommand: `git worktree remove --force "${ws.workingDir}"`,
        }));

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              staleWorktrees,
              count: staleWorktrees.length,
              message: `Found ${staleWorktrees.length} closed workspace(s) with stale worktrees. Remove each manually using the 'removeCommand' shown, or run: git worktree remove --force <path>`,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Error scanning for stale worktrees: ${err instanceof Error ? err.message : String(err)}`,
          }],
        };
      }
    },
  );
}
