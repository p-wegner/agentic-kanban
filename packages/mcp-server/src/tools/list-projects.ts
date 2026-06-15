import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { prodDeps, type ToolDeps } from "./deps.js";

export function registerListProjects(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;
  server.tool(
    "list_projects",
    "List all registered projects on the kanban board. Shows project name, ID, repo path, default branch, and remote URL. The currently active project is indicated in the result.",
    {
      includeArchived: z.boolean().optional().describe("Include archived projects (default: false)"),
    },
    async ({ includeArchived }) => {
      try {
        let allProjects = await db
          .select({
            id: schema.projects.id,
            name: schema.projects.name,
            repoPath: schema.projects.repoPath,
            repoName: schema.projects.repoName,
            defaultBranch: schema.projects.defaultBranch,
            remoteUrl: schema.projects.remoteUrl,
            description: schema.projects.description,
            color: schema.projects.color,
            archivedAt: schema.projects.archivedAt,
            createdAt: schema.projects.createdAt,
            updatedAt: schema.projects.updatedAt,
          })
          .from(schema.projects);

        if (!includeArchived) {
          allProjects = allProjects.filter((p) => p.archivedAt == null);
        }

        const activePref = await db
          .select({ value: schema.preferences.value })
          .from(schema.preferences)
          .where(eq(schema.preferences.key, "activeProjectId"))
          .limit(1);
        const activeId = activePref.length > 0 ? activePref[0].value : null;

        const result = allProjects.map((p) => ({
          ...p,
          isActive: p.id === activeId,
        }));

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ activeProjectId: activeId, projects: result }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Error listing projects: ${err instanceof Error ? err.message : String(err)}`,
          }],
        };
      }
    },
  );
}
