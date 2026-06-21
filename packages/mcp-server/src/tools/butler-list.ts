import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getServerPort } from "../server-url.js";

interface ButlerEntry {
  id: string;
  name: string;
  model?: string;
  isRunning?: boolean;
  sessionId?: string | null;
  [key: string]: unknown;
}

export function registerButlerList(server: McpServer) {
  server.tool(
    "butler_list",
    "List all defined butlers and their per-project runtime state (warm/stopped, session id). Equivalent to CLI `butler list`.",
    {
      projectId: z.string().describe("The project ID"),
    },
    async ({ projectId }) => {
      try {
        const res = await fetch(`http://127.0.0.1:${getServerPort()}/api/projects/${projectId}/butlers`);
        const data = (await res.json()) as ButlerEntry[] | { error?: string };
        if (!res.ok) {
          const err = Array.isArray(data) ? res.statusText : ((data).error ?? res.statusText);
          return { content: [{ type: "text" as const, text: `Butler list error: ${err}` }] };
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
