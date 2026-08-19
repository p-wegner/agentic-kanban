import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { mcpJson, mcpText, workspaceClosedError, workspaceMissingWorkingDirError, workspaceNotFoundError } from "../db-utils.js";
import { prodDeps, type ToolDeps } from "./deps.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

function extractChangedFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (match) files.add(match[2]);
  }
  return [...files];
}

export function registerGetWorkspaceDiff(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema, getDiff, getDiffShortstat } = deps;
  server.tool(
    "get_workspace_diff",
    "Get the git diff for a workspace's working directory",
    {
      workspaceId: z.string().describe("The workspace ID"),
      baseBranch: z.string().optional().describe("Base branch to diff against (default: 'main')"),
    },
    async ({ workspaceId, baseBranch }) => {
      const workspaces = await db.select().from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1);

      if (workspaces.length === 0) return workspaceNotFoundError(workspaceId);

      const ws = workspaces[0];
      if (ws.status === "closed") return workspaceClosedError(workspaceId);
      if (!ws.workingDir?.trim()) return workspaceMissingWorkingDirError(workspaceId);

      try {
        let resolvedBaseBranch = baseBranch || ws.baseBranch;
        if (!resolvedBaseBranch) {
          const issueRows = await db.select({ projectId: schema.issues.projectId })
            .from(schema.issues)
            .where(eq(schema.issues.id, ws.issueId))
            .limit(1);
          if (issueRows.length > 0) {
            const projectRows = await db.select({ defaultBranch: schema.projects.defaultBranch })
              .from(schema.projects)
              .where(eq(schema.projects.id, issueRows[0].projectId))
              .limit(1);
            resolvedBaseBranch = projectRows[0]?.defaultBranch ?? null;
          }
        }
        if (!resolvedBaseBranch) {
          return mcpText("No base branch configured for this workspace or project.");
        }

        const [diff, stats] = await Promise.all([
          getDiff(ws.workingDir, resolvedBaseBranch),
          getDiffShortstat(ws.workingDir, resolvedBaseBranch),
        ]);

        if (!diff.trim()) {
          return mcpText("No changes detected.");
        }

        return mcpJson({
              workspaceId,
              baseBranch: resolvedBaseBranch,
              changedFiles: extractChangedFiles(diff),
              stats,
              diff,
            });
      } catch (err) {
        return mcpText(`Failed to get diff: ${errorMessage(err)}`);
      }
    },
  );
}
