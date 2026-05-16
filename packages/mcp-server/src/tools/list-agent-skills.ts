import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";

export function registerListAgentSkills(server: McpServer) {
  server.tool(
    "list_agent_skills",
    "List all available agent skills that can be applied to workspaces",
    {},
    async () => {
      const rows = await db.select().from(schema.agentSkills).orderBy(schema.agentSkills.name);
      const summary = rows.map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        model: s.model,
        isBuiltin: s.isBuiltin,
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    },
  );
}
