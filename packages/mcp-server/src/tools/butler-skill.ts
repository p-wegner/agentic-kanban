import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getServerPort } from "../server-url.js";

interface ButlerSkillResponse {
  prompt?: string;
  isOverridden?: boolean;
  error?: string;
  [key: string]: unknown;
}

export function registerGetButlerSkill(server: McpServer) {
  server.tool(
    "get_butler_skill",
    "Get the butler's editable system prompt (skill) for a project. Returns the prompt text and whether it is a project-scoped override or the global default. Equivalent to CLI `butler skill get`.",
    {
      projectId: z.string().describe("The project ID"),
      butler: z.string().optional().describe('Which butler to get the skill for (definition id, e.g. "smart"). Defaults to the project\'s default butler.'),
    },
    async ({ projectId, butler }) => {
      try {
        const q = butler && butler !== "default" ? `?butler=${encodeURIComponent(butler)}` : "";
        const res = await fetch(`http://127.0.0.1:${getServerPort()}/api/projects/${projectId}/butler/skill${q}`);
        const data = (await res.json()) as ButlerSkillResponse;
        if (!res.ok) {
          return { content: [{ type: "text" as const, text: `Butler get-skill error: ${data.error ?? res.statusText}` }] };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to reach the butler (is the server running on port ${getServerPort()}?): ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
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
      try {
        const q = butler && butler !== "default" ? `?butler=${encodeURIComponent(butler)}` : "";
        const res = await fetch(`http://127.0.0.1:${getServerPort()}/api/projects/${projectId}/butler/skill${q}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        });
        const data = (await res.json()) as ButlerSkillResponse;
        if (!res.ok) {
          return { content: [{ type: "text" as const, text: `Butler set-skill error: ${data.error ?? res.statusText}` }] };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to reach the butler (is the server running on port ${getServerPort()}?): ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );
}
