import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getServerPort } from "../server-url.js";

export function registerButlerState(server: McpServer) {
  server.tool(
    "butler_state",
    "Get the butler's current state for a project: whether the warm session is active, current model/profile selection, context-window usage, and MCP connection status.",
    {
      projectId: z.string().describe("The project ID"),
    },
    async ({ projectId }) => {
      try {
        const res = await fetch(`http://127.0.0.1:${getServerPort()}/api/projects/${projectId}/butler`);
        const data = await res.json() as Record<string, unknown> & { error?: string };
        if (!res.ok) {
          return { content: [{ type: "text" as const, text: `Butler state error: ${data.error ?? res.statusText}` }] };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to reach the butler (is the server running on port ${getServerPort()}?): ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );
}
