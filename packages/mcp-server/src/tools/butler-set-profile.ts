import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const SERVER_PORT = Number(process.env.SERVER_PORT) || 3001;

export function registerButlerSetProfile(server: McpServer) {
  server.tool(
    "butler_set_profile",
    "Switch the butler's Claude profile. This restarts the warm session (different auth/endpoint cannot resume). Pass an empty profile to revert to the global default.",
    {
      projectId: z.string().describe("The project ID"),
      profile: z.string().describe("Claude profile name, or empty string to inherit the global claude_profile"),
    },
    async ({ projectId, profile }) => {
      try {
        const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/projects/${projectId}/butler/profile`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile }),
        });
        const data = (await res.json()) as { ok?: boolean; profile?: string; active?: boolean; error?: string };
        if (!res.ok) {
          return { content: [{ type: "text" as const, text: `Butler set-profile error: ${data.error ?? res.statusText}` }] };
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
