import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { boardApiUrl } from "../server-url.js";

export function registerRegisterProject(server: McpServer) {
  server.tool(
    "register_project",
    "Register an existing git repository as a project on the kanban board. Auto-detects repo name, default branch, and remote URL. Creates the default statuses (Backlog, Todo, In Progress, In Review, AI Reviewed, Done, Cancelled) and sets the project as active. If the repo is already registered, returns the existing project.",
    {
      repoPath: z.string().describe("Absolute path to the git repository to register"),
      name: z.string().optional().describe("Custom project name (defaults to the repository directory name)"),
      description: z.string().optional().describe("Optional project description"),
      color: z.string().optional().describe("Optional project color (hex or CSS color)"),
      gitignoreTemplate: z.string().optional().describe("Optional gitignore template name to seed the .gitignore"),
      generateReadme: z.boolean().optional().describe("If true, create a minimal README.md when none exists (default: false)"),
      exportSkillsOnRegistration: z.boolean().optional().describe("If true, export built-in skills into the repo's .claude/skills/ on registration"),
    },
    async ({ repoPath, name, description, color, gitignoreTemplate, generateReadme, exportSkillsOnRegistration }) => {
      try {
        const body: Record<string, unknown> = { repoPath };
        if (name !== undefined) body.name = name;
        if (description !== undefined) body.description = description;
        if (color !== undefined) body.color = color;
        if (gitignoreTemplate !== undefined) body.gitignoreTemplate = gitignoreTemplate;
        if (generateReadme !== undefined) body.generateReadme = generateReadme;
        if (exportSkillsOnRegistration !== undefined) body.exportSkillsOnRegistration = exportSkillsOnRegistration;

        const res = await fetch(boardApiUrl("/api/projects"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        const data = await res.json() as Record<string, unknown>;

        if (!res.ok) {
          const errMsg = (data.error as string) ?? res.statusText;
          // 409 = already registered — surface the project details rather than erroring
          if (res.status === 409) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ alreadyRegistered: true, ...data }, null, 2) }] };
          }
          return { content: [{ type: "text" as const, text: `Error registering project: ${errMsg}` }] };
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
