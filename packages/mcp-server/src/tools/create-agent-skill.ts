import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

export function registerCreateAgentSkill(server: McpServer) {
  server.tool(
    "create_agent_skill",
    "Create a new agent skill with a name, description, and prompt template",
    {
      name: z.string().describe("Unique skill name (e.g. 'dependency-analyzer')"),
      description: z.string().describe("Short description of what the skill does"),
      prompt: z.string().describe("The full prompt template that gets injected into the agent's context"),
      model: z.string().optional().describe("Optional model override (e.g. 'haiku', 'sonnet', 'opus')"),
    },
    async ({ name, description, prompt, model }) => {
      const existing = await db.select().from(schema.agentSkills).where(eq(schema.agentSkills.name, name)).limit(1);
      if (existing.length > 0) {
        return { content: [{ type: "text" as const, text: `Skill '${name}' already exists with ID ${existing[0].id}` }] };
      }

      const id = randomUUID();
      const now = new Date().toISOString();

      await db.insert(schema.agentSkills).values({
        id,
        name,
        description,
        prompt,
        model: model ?? null,
        isBuiltin: false,
        createdAt: now,
        updatedAt: now,
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ id, name, description, model: model ?? null }, null, 2) }],
      };
    },
  );
}
