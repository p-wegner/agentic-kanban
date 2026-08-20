import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { prodDeps, type ToolDeps } from "./deps.js";
import { mcpError, mcpJson, mcpText } from "../db-utils.js";

export function registerGetAgentSkill(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;

  server.tool(
    "get_agent_skill",
    "Get full details of an agent skill including its prompt",
    {
      skillId: z.string().optional().describe("Skill ID"),
      name: z.string().optional().describe("Skill name (alternative to skillId)"),
    },
    async ({ skillId, name }) => {
      if (!skillId && !name) {
        return mcpText("Provide either skillId or name");
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

      return mcpJson(rows[0]);
    },
  );
}
