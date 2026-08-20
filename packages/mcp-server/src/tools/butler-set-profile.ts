import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { butlerCall } from "../butler-api.js";

export function registerButlerSetProfile(server: McpServer) {
  server.tool(
    "butler_set_profile",
    "Switch the butler's Claude profile. This restarts the warm session (different auth/endpoint cannot resume). Pass an empty profile to revert to the global default.",
    {
      projectId: z.string().describe("The project ID"),
      profile: z.string().describe("Claude profile name, or empty string to inherit the global claude_profile"),
    },
    async ({ projectId, profile }) => {
      return await butlerCall("Butler set-profile", `/api/projects/${projectId}/butler/profile`, {
        method: "POST",
        body: JSON.stringify({ profile }),
      });
    },
  );
}
