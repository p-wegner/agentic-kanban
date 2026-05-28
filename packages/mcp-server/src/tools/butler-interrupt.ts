import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const SERVER_PORT = Number(process.env.SERVER_PORT) || 3001;

export function registerButlerInterrupt(server: McpServer) {
  server.tool(
    "butler_interrupt",
    "Interrupt the butler's in-flight turn. The warm session is preserved (context is kept); only the current response generation is cancelled.",
    {
      projectId: z.string().describe("The project ID"),
    },
    async ({ projectId }) => {
      try {
        const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/projects/${projectId}/butler/interrupt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const data = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok) {
          return { content: [{ type: "text" as const, text: `Butler interrupt error: ${data.error ?? res.statusText}` }] };
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
