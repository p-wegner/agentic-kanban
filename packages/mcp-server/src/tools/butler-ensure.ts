import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { butlerCall, butlerQuery } from "../butler-api.js";

export function registerButlerEnsure(server: McpServer) {
  server.tool(
    "butler_ensure",
    "Start (warm) the butler session for a project if it is not already running. Equivalent to CLI `butler ensure`. Safe to call repeatedly — no-ops when the butler is already warm.",
    {
      projectId: z.string().describe("The project ID"),
      butler: z.string().optional().describe('Which butler to ensure (definition id, e.g. "smart"). Defaults to the project\'s default butler.'),
    },
    async ({ projectId, butler }) => {
      return await butlerCall("Butler ensure", `/api/projects/${projectId}/butler/ensure${butlerQuery(butler)}`, {
        method: "POST",
        body: "{}",
      });
    },
  );
}
