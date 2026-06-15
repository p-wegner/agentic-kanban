import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq, or } from "drizzle-orm";
import { prodDeps, type ToolDeps } from "./deps.js";
import { boardApiUrl } from "../server-url.js";

export function registerUnregisterProject(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;
  server.tool(
    "unregister_project",
    "Remove a project registration from the kanban board by name or project ID. Cascade-deletes all associated data: issues, workspaces, sessions, issue tags, and project statuses. This is irreversible — use with care.",
    {
      nameOrId: z.string().describe("Project name or project ID to unregister"),
    },
    async ({ nameOrId }) => {
      try {
        // Resolve the project ID by name or ID
        const rows = await db
          .select({ id: schema.projects.id, name: schema.projects.name })
          .from(schema.projects)
          .where(or(eq(schema.projects.name, nameOrId), eq(schema.projects.id, nameOrId)))
          .limit(1);

        if (rows.length === 0) {
          return { content: [{ type: "text" as const, text: `Project "${nameOrId}" not found.` }] };
        }

        const projectId = rows[0].id;
        const projectName = rows[0].name;

        // Use REST DELETE so the server handles cascade + board event broadcast
        const res = await fetch(boardApiUrl(`/api/projects/${projectId}`), {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
        });

        if (!res.ok) {
          let errMsg = res.statusText;
          try {
            const data = await res.json() as Record<string, unknown>;
            errMsg = (data.error as string) ?? errMsg;
          } catch { /* ignore parse error */ }
          return { content: [{ type: "text" as const, text: `Error unregistering project: ${errMsg}` }] };
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, message: `Unregistered project "${projectName}" (${projectId})` }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to unregister project: ${err instanceof Error ? err.message : String(err)}`,
          }],
        };
      }
    },
  );
}
