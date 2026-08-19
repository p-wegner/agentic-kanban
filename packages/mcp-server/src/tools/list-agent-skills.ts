import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { sql } from "drizzle-orm";
import { mcpJson } from "../db-utils.js";

export function registerListAgentSkills(server: McpServer) {
  server.tool(
    "list_agent_skills",
    "List all available agent skills that can be applied to workspaces",
    {
      projectId: z.string().optional().describe("Filter to project-specific + global skills for this project"),
      init: z.boolean().optional().describe("Filter to init skills only — one-time project-init steps"),
    },
    async ({ projectId, init }) => {
      const initCondition = init ? sql`${schema.agentSkills.isInit} = 1` : undefined;
      let rows;
      if (projectId) {
        const scopeCondition = sql`${schema.agentSkills.projectId} IS NULL OR ${schema.agentSkills.projectId} = ${projectId}`;
        rows = await db.select().from(schema.agentSkills)
          .where(initCondition ? sql`(${scopeCondition}) AND ${initCondition}` : scopeCondition)
          .orderBy(schema.agentSkills.name);
      } else {
        rows = await db.select().from(schema.agentSkills)
          .where(initCondition)
          .orderBy(schema.agentSkills.name);
      }
      const summary = rows.map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        model: s.model,
        projectId: s.projectId,
        isBuiltin: s.isBuiltin,
        isInit: s.isInit,
      }));
      return mcpJson(summary);
    },
  );
}
