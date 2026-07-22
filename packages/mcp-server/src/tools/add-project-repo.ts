import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { boardApiUrl } from "../server-url.js";

export function registerAddProjectRepo(server: McpServer) {
  server.tool(
    "add_project_repo",
    "Attach an ADDITIONAL git repository to an existing multi-repo project (the 'full-peers' model). The project's registered repo is the LEADING repo (the agent starts there); every repo added here becomes a sibling that each new workspace also gets a worktree for on the same branch, with merge landing every repo that has commits. To build a multi-repo project: first `register_project` the leading repo, then call this once per sibling with that project's id. Provide exactly one of `path` (absolute path to an existing local repo), `cloneUrl` (clone a remote), or `createName` (scaffold a brand-new git repo in a new folder created inside the project folder, beside the leading repo).",
    {
      projectId: z.string().describe("Id of the project to attach the repo to (from register_project / list_projects)"),
      path: z.string().optional().describe("Absolute path to an existing local git repository to add as a sibling"),
      cloneUrl: z.string().optional().describe("Git URL to clone into the server's repos directory and add as a sibling"),
      createName: z.string().optional().describe("Name of a NEW repo to scaffold (mkdir + git init + initial commit) inside the project folder, then attach as a sibling"),
      name: z.string().optional().describe("Optional display name (defaults to the repo directory name; must be unique among the project's repos)"),
      setupScript: z.string().optional().describe("Optional per-repo setup/install command run when a workspace worktree is created for this repo (e.g. 'pnpm install')"),
      composeFile: z.string().optional().describe("Optional per-repo Docker Compose file for this repo's service stack"),
    },
    async ({ projectId, path, cloneUrl, createName, name, setupScript, composeFile }) => {
      if ([path, cloneUrl, createName].filter((v) => typeof v === "string" && v.trim()).length !== 1) {
        return { content: [{ type: "text" as const, text: "Error: provide exactly one of `path`, `cloneUrl`, or `createName`." }] };
      }
      try {
        const body: Record<string, unknown> = {};
        if (path !== undefined) body.path = path;
        if (cloneUrl !== undefined) body.cloneUrl = cloneUrl;
        if (createName !== undefined) body.createName = createName;
        if (name !== undefined) body.name = name;
        if (setupScript !== undefined) body.setupScript = setupScript;
        if (composeFile !== undefined) body.composeFile = composeFile;

        const res = await fetch(boardApiUrl(`/api/projects/${projectId}/repos`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json() as Record<string, unknown>;
        if (!res.ok) {
          const errMsg = (data.error as string) ?? res.statusText;
          return { content: [{ type: "text" as const, text: `Error adding repo to project: ${errMsg}` }] };
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
