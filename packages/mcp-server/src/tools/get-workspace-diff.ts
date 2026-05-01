import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";
import * as gitService from "../git-service.js";

export function registerGetWorkspaceDiff(server: McpServer) {
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

      if (workspaces.length === 0) {
        return { content: [{ type: "text" as const, text: `Workspace ${workspaceId} not found` }] };
      }

      const ws = workspaces[0];
      if (!ws.workingDir) {
        return { content: [{ type: "text" as const, text: "Workspace has no working directory" }] };
      }

      try {
        const diff = await gitService.getDiff(ws.workingDir, baseBranch || "main");

        if (!diff.trim()) {
          return { content: [{ type: "text" as const, text: "No changes detected." }] };
        }

        return {
          content: [{ type: "text" as const, text: diff }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to get diff: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );
}
