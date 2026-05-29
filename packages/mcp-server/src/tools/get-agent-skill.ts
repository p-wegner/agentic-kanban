import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";
import { requireEntity, mcpError } from "../db-utils.js";

export function registerGetAgentSkill(server: McpServer) {
  server.tool(
    "get_agent_skill",
    "Get full details of an agent skill including its prompt",
    {
      skillId: z.string().optional().describe("Skill ID"),
      name: z.string().optional().describe("Skill name (alternative to skillId)"),
    },
    async ({ skillId, name }) => {
      if (!skillId && !name) {
        return { content: [{ type: "text" as const, text: "Provide either skillId or name" }] };
      }

      let rows;
      if (skillId) {
        rows = await db.select().from(schema.agentSkills).where(eq(schema.agentSkills.id, skillId)).limit(1);
      } else {
        rows = await db.select().from(schema.agentSkills).where(eq(schema.agentSkills.name, name!)).limit(1);
      }

      if (rows.length === 0) {
        return mcpError(`Skill not found: ${skillId ?? name}`);
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(rows[0], null, 2) }],
      };
    },
  );
}
