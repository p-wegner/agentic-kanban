import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { boardApi, boardErrorText, mcpJson, mcpText } from "../board-call.js";
import { eq, or } from "drizzle-orm";
import { prodDeps, type ToolDeps } from "./deps.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

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
          return mcpText(`Project "${nameOrId}" not found.`);
        }

        const projectId = rows[0].id;
        const projectName = rows[0].name;

        // Use REST DELETE so the server handles cascade + board event broadcast
        const { ok, statusText, data } = await boardApi(`/api/projects/${projectId}`, { method: "DELETE" });

        if (!ok) return mcpText(`Error unregistering project: ${boardErrorText(data, statusText)}`);

        return mcpJson({ success: true, message: `Unregistered project "${projectName}" (${projectId})` });
      } catch (err) {
        return mcpText(`Failed to unregister project: ${errorMessage(err)}`);
      }
    },
  );
}
