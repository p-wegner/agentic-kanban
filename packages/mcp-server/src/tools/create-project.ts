import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { boardApiUrl } from "../server-url.js";

export function registerCreateProject(server: McpServer) {
  server.tool(
    "create_project",
    "Create a new directory, initialize it as a git repository, and register it as a project on the kanban board. Use register_project instead if the repo already exists. The directory is created inside the configured projects_base_path preference unless an explicit path is provided.",
    {
      name: z.string().describe("Name of the new project folder to create"),
      path: z.string().optional().describe("Base directory to create the folder in (overrides the projects_base_path preference)"),
      description: z.string().optional().describe("Optional project description"),
      color: z.string().optional().describe("Optional project color (hex or CSS color)"),
      gitignoreTemplate: z.string().optional().describe("Optional gitignore template name"),
      generateReadme: z.boolean().optional().describe("If true, create a minimal README.md (default: false)"),
    },
    async ({ name, path, description, color, gitignoreTemplate, generateReadme }) => {
      try {
        const body: Record<string, unknown> = { name };
        if (path !== undefined) body.path = path;
        if (description !== undefined) body.description = description;
        if (color !== undefined) body.color = color;
        if (gitignoreTemplate !== undefined) body.gitignoreTemplate = gitignoreTemplate;
        if (generateReadme !== undefined) body.generateReadme = generateReadme;

        const res = await fetch(boardApiUrl("/api/projects/create"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        const data = await res.json() as Record<string, unknown>;

        if (!res.ok) {
          const errMsg = (data.error as string) ?? res.statusText;
          return { content: [{ type: "text" as const, text: `Error creating project: ${errMsg}` }] };
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
