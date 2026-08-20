import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { butlerCall } from "../butler-api.js";

export function registerButlerState(server: McpServer) {
  server.tool(
    "butler_state",
    "Get the butler's current state for a project: whether the warm session is active, current model/profile selection, context-window usage, and MCP connection status.",
    {
      projectId: z.string().describe("The project ID"),
    },
    async ({ projectId }) => {
      return await butlerCall("Butler state", `/api/projects/${projectId}/butler`);
    },
  );
}
