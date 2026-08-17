import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { butlerCall, butlerQuery } from "../butler-api.js";

export function registerGetButlerSkill(server: McpServer) {
  server.tool(
    "get_butler_skill",
    "Get the butler's editable system prompt (skill) for a project. Returns the prompt text and whether it is a project-scoped override or the global default. Equivalent to CLI `butler skill get`.",
    {
      projectId: z.string().describe("The project ID"),
      butler: z.string().optional().describe('Which butler to get the skill for (definition id, e.g. "smart"). Defaults to the project\'s default butler.'),
    },
    async ({ projectId, butler }) => {
      return await butlerCall("Butler get-skill", `/api/projects/${projectId}/butler/skill${butlerQuery(butler)}`, undefined, { pretty: true });
    },
  );
}

export function registerSetButlerSkill(server: McpServer) {
  server.tool(
    "set_butler_skill",
    "Set (upsert) the butler's system prompt (skill) for a project, creating a project-scoped override. Pass an empty string to reset to the global default. Equivalent to CLI `butler skill set <prompt>`.",
    {
      projectId: z.string().describe("The project ID"),
      prompt: z.string().describe("The new butler system prompt. Pass an empty string to reset to the global default."),
      butler: z.string().optional().describe('Which butler to set the skill for (definition id, e.g. "smart"). Defaults to the project\'s default butler.'),
    },
    async ({ projectId, prompt, butler }) => {
      return await butlerCall("Butler set-skill", `/api/projects/${projectId}/butler/skill${butlerQuery(butler)}`, {
        method: "PUT",
        body: JSON.stringify({ prompt }),
      }, { pretty: true });
    },
  );
}
