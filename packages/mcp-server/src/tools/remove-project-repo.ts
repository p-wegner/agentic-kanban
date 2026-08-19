import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { boardApi, boardErrorText, mcpJson, mcpText, mcpUnreachable } from "../board-call.js";

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
        const { ok, statusText, data } = await boardApi(`/api/projects/${projectId}/repos/${repoId}`, {
          method: "DELETE",
        });
        if (!ok) return mcpText(`Error removing repo from project: ${boardErrorText(data, statusText)}`);
        return mcpJson(data);
      } catch (err) {
        return mcpUnreachable(err);
      }
    },
  );
}
