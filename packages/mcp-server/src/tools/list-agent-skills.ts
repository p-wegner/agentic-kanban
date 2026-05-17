import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { sql } from "drizzle-orm";

export function registerListAgentSkills(server: McpServer) {
  server.tool(
    "list_agent_skills",
    "List all available agent skills that can be applied to workspaces",
    {
      projectId: z.string().optional().describe("Filter to project-specific + global skills for this project"),
    },
    async ({ projectId }) => {
      let rows;
      if (projectId) {
        rows = await db.select().from(schema.agentSkills)
          .where(sql`${schema.agentSkills.projectId} IS NULL OR ${schema.agentSkills.projectId} = ${projectId}`)
          .orderBy(schema.agentSkills.name);
      } else {
        rows = await db.select().from(schema.agentSkills).orderBy(schema.agentSkills.name);
      }
      const summary = rows.map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        model: s.model,
        projectId: s.projectId,
        isBuiltin: s.isBuiltin,
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    },
  );
}
