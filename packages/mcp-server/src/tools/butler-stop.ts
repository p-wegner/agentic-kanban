import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { butlerCall, butlerQuery } from "../butler-api.js";

export function registerButlerStop(server: McpServer) {
  server.tool(
    "butler_stop",
    "Stop the butler's warm session and forget its resume id. The butler can be restarted later via butler_ensure. Equivalent to CLI `butler stop`.",
    {
      projectId: z.string().describe("The project ID"),
      butler: z.string().optional().describe('Which butler to stop (definition id, e.g. "smart"). Defaults to the project\'s default butler.'),
    },
    async ({ projectId, butler }) => {
      return await butlerCall("Butler stop", `/api/projects/${projectId}/butler${butlerQuery(butler)}`, { method: "DELETE" });
    },
  );
}
