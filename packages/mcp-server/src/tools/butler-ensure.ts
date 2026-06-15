import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getServerPort } from "../server-url.js";

export function registerButlerEnsure(server: McpServer) {
  server.tool(
    "butler_ensure",
    "Start (warm) the butler session for a project if it is not already running. Equivalent to CLI `butler ensure`. Safe to call repeatedly — no-ops when the butler is already warm.",
    {
      projectId: z.string().describe("The project ID"),
      butler: z.string().optional().describe('Which butler to ensure (definition id, e.g. "smart"). Defaults to the project\'s default butler.'),
    },
    async ({ projectId, butler }) => {
      try {
        const q = butler && butler !== "default" ? `?butler=${encodeURIComponent(butler)}` : "";
        const res = await fetch(`http://127.0.0.1:${getServerPort()}/api/projects/${projectId}/butler/ensure${q}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const data = (await res.json()) as { ok?: boolean; sessionId?: string; error?: string };
        if (!res.ok) {
          return { content: [{ type: "text" as const, text: `Butler ensure error: ${data.error ?? res.statusText}` }] };
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
