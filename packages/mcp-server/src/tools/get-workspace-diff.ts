import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { requireEntity } from "../db-utils.js";
import { prodDeps, type ToolDeps } from "./deps.js";

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

      const r = requireEntity(workspaces, workspaceId, "Workspace");
      if (!r.ok) return r.error;

      const ws = r.value;
      if (!ws.workingDir) {
        return { content: [{ type: "text" as const, text: "Workspace has no working directory" }] };
      }

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
          return { content: [{ type: "text" as const, text: "No base branch configured for this workspace or project." }] };
        }

        const [diff, stats] = await Promise.all([
          getDiff(ws.workingDir, resolvedBaseBranch),
          getDiffShortstat(ws.workingDir, resolvedBaseBranch),
        ]);

        if (!diff.trim()) {
          return { content: [{ type: "text" as const, text: "No changes detected." }] };
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              workspaceId,
              baseBranch: resolvedBaseBranch,
              changedFiles: extractChangedFiles(diff),
              stats,
              diff,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to get diff: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );
}
