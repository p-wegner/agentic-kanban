import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { boardApiUrl } from "../server-url.js";

export function registerRemoveProjectRepo(server: McpServer) {
  server.tool(
    "remove_project_repo",
    "Detach an ADDITIONAL (sibling) repo from a multi-repo project. Removes only the project↔repo association — the checkout on disk is left untouched and existing workspaces keep their worktrees. Use `list_project_repos` to find the repoId. Cannot remove the leading repo (that is unregister_project territory).",
    {
      projectId: z.string().describe("Id of the project to detach the repo from"),
      repoId: z.string().describe("Id of the sibling repo to remove (from list_project_repos)"),
    },
    async ({ projectId, repoId }) => {
      try {
        const res = await fetch(boardApiUrl(`/api/projects/${projectId}/repos/${repoId}`), {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
        });
        const data = await res.json() as Record<string, unknown>;
        if (!res.ok) {
          const errMsg = (data.error as string) ?? res.statusText;
          return { content: [{ type: "text" as const, text: `Error removing repo from project: ${errMsg}` }] };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to reach the board server (is it running?): ${err instanceof Error ? err.message : String(err)}`,
          }],
        };
      }
    },
  );
}
