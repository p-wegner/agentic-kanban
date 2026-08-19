import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { boardApi, boardErrorText, mcpJson, mcpText, mcpUnreachable } from "../board-call.js";

export function registerListProjectRepos(server: McpServer) {
  server.tool(
    "list_project_repos",
    "List the ADDITIONAL (sibling) repos attached to a multi-repo project. Returns an array of repo rows ({ id, path, name, defaultBranch, setupScript, composeFile }). Does NOT include the leading repo (that is the project's own repoPath, from list_projects). An empty array means the project is single-repo.",
    {
      projectId: z.string().describe("Id of the project whose sibling repos to list"),
    },
    async ({ projectId }) => {
      try {
        const { ok, statusText, data } = await boardApi(`/api/projects/${projectId}/repos`);
        if (!ok) return mcpText(`Error listing project repos: ${boardErrorText(data, statusText)}`);
        return mcpJson(data);
      } catch (err) {
        return mcpUnreachable(err);
      }
    },
  );
}
