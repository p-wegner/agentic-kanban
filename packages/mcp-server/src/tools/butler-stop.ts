import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getServerPort } from "../server-url.js";

export function registerButlerStop(server: McpServer) {
  server.tool(
    "butler_stop",
    "Stop the butler's warm session and forget its resume id. The butler can be restarted later via butler_ensure. Equivalent to CLI `butler stop`.",
    {
      projectId: z.string().describe("The project ID"),
      butler: z.string().optional().describe('Which butler to stop (definition id, e.g. "smart"). Defaults to the project\'s default butler.'),
    },
    async ({ projectId, butler }) => {
      try {
        const q = butler && butler !== "default" ? `?butler=${encodeURIComponent(butler)}` : "";
        const res = await fetch(`http://127.0.0.1:${getServerPort()}/api/projects/${projectId}/butler${q}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
        });
        const data = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok) {
          return { content: [{ type: "text" as const, text: `Butler stop error: ${data.error ?? res.statusText}` }] };
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
