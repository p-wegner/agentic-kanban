import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { boardApiUrl } from "../server-url.js";

export function registerListProjectRepos(server: McpServer) {
  server.tool(
    "list_project_repos",
    "List the ADDITIONAL (sibling) repos attached to a multi-repo project. Returns an array of repo rows ({ id, path, name, defaultBranch, setupScript, composeFile }). Does NOT include the leading repo (that is the project's own repoPath, from list_projects). An empty array means the project is single-repo.",
    {
      projectId: z.string().describe("Id of the project whose sibling repos to list"),
    },
    async ({ projectId }) => {
      try {
        const res = await fetch(boardApiUrl(`/api/projects/${projectId}/repos`), {
          headers: { "Content-Type": "application/json" },
        });
        const data = await res.json();
        if (!res.ok) {
          const errMsg = (data as Record<string, unknown>).error as string ?? res.statusText;
          return { content: [{ type: "text" as const, text: `Error listing project repos: ${errMsg}` }] };
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
