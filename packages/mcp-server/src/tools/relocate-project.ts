import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { boardApi, boardErrorText, mcpJson, mcpUnreachable } from "../board-call.js";
import { mcpError } from "../db-utils.js";

export function registerRelocateProject(server: McpServer) {
  server.tool(
    "relocate_project",
    "Move a registered project to a new checkout path WITHOUT unregistering it — its issues, workspaces, sessions and history are all kept. Rewrites every persisted path that pointed at the old location: projects.repo_path, the project's repos rows (path + worktree_path), its workspaces' working_dir, and the projects_base_path preference when it named the old parent. Issue text, comments and session records are deliberately left alone — they record what was true then. Pass `fromPrefix`/`toPrefix` instead of `projectId`/`newRepoPath` to relocate EVERY project under one directory into another (a directory consolidation). Set `moveFiles` to have the board rename the directories on disk and run `git worktree repair` so the worktrees relink; without it the destination must already be a git checkout. ALWAYS run with `dryRun: true` first — it returns the exact rows and directories that would change and touches nothing.",
    {
      projectId: z.string().optional().describe("Id of the project to relocate (single-project mode)"),
      newRepoPath: z.string().optional().describe("Absolute path the project should live at (single-project mode)"),
      fromPrefix: z.string().optional().describe("Absolute directory to move projects OUT of (batch mode)"),
      toPrefix: z.string().optional().describe("Absolute directory to move projects INTO (batch mode)"),
      moveFiles: z.boolean().optional().describe("Also rename the directories on disk and repair the worktrees"),
      dryRun: z.boolean().optional().describe("Report the plan and change nothing — do this first"),
      force: z.boolean().optional().describe("Relocate even while one of the project's agents is running"),
      updateBasePath: z.boolean().optional().describe("Rewrite the projects_base_path preference when it named the old parent (default true)"),
    },
    async ({ projectId, newRepoPath, fromPrefix, toPrefix, ...options }) => {
      const single = !!(projectId && newRepoPath);
      const batch = !!(fromPrefix && toPrefix);
      if (single === batch) {
        return mcpError(
          "Error: provide either `projectId` + `newRepoPath` (one project) or `fromPrefix` + `toPrefix` (every project under a directory), not both.",
        );
      }
      try {
        const { ok, statusText, data } = single
          ? await boardApi(`/api/projects/${projectId}/relocate`, {
              method: "POST",
              body: JSON.stringify({ newRepoPath, ...options }),
            })
          : await boardApi("/api/projects/relocate-prefix", {
              method: "POST",
              body: JSON.stringify({ fromPrefix, toPrefix, ...options }),
            });
        if (!ok) return mcpError(`Error relocating project: ${boardErrorText(data, statusText)}`);
        return mcpJson(data);
      } catch (err) {
        return mcpUnreachable(err);
      }
    },
  );
}
