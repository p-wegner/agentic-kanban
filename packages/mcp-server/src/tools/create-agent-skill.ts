import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq, and, isNull } from "drizzle-orm";
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
      projectId: z.string().optional().describe("Optional project ID to scope this skill to a specific project. Omit for global."),
    },
    async ({ name, description, prompt, model, projectId }) => {
      if (/[\/\\]|\.\./.test(name)) {
        return { content: [{ type: "text" as const, text: "Error: Skill name cannot contain '/', '\\', or '..'" }] };
      }

      const scopeProjectId = projectId || null;

      // Check for duplicate name within same scope
      const scopeCondition = scopeProjectId
        ? and(eq(schema.agentSkills.name, name), eq(schema.agentSkills.projectId, scopeProjectId))
        : and(eq(schema.agentSkills.name, name), isNull(schema.agentSkills.projectId));
      const existing = await db.select().from(schema.agentSkills).where(scopeCondition).limit(1);
      if (existing.length > 0) {
        return { content: [{ type: "text" as const, text: `Skill '${name}' already exists in this scope with ID ${existing[0].id}` }] };
      }

      const id = randomUUID();
      const now = new Date().toISOString();

      await db.insert(schema.agentSkills).values({
        id,
        name,
        description,
        prompt,
        model: model ?? null,
        projectId: scopeProjectId,
        isBuiltin: false,
        createdAt: now,
        updatedAt: now,
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ id, name, description, model: model ?? null, projectId: scopeProjectId }, null, 2) }],
      };
    },
  );
}
