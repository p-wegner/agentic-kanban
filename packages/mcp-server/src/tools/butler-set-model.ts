import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const SERVER_PORT = Number(process.env.SERVER_PORT) || 3001;

export function registerButlerSetModel(server: McpServer) {
  server.tool(
    "butler_set_model",
    "Switch the butler's model live (no session restart, context preserved). Pass an empty model string to revert to the profile/CLI default.",
    {
      projectId: z.string().describe("The project ID"),
      model: z.string().describe('Model name (e.g. "opus", "sonnet", "haiku") or empty string to use the profile default'),
    },
    async ({ projectId, model }) => {
      try {
        const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/projects/${projectId}/butler/model`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model }),
        });
        const data = (await res.json()) as { ok?: boolean; model?: string; applied?: boolean; error?: string };
        if (!res.ok) {
          return { content: [{ type: "text" as const, text: `Butler set-model error: ${data.error ?? res.statusText}` }] };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to reach the butler (is the server running on port ${SERVER_PORT}?): ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );
}
