import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { butlerCall } from "../butler-api.js";

export function registerButlerSetModel(server: McpServer) {
  server.tool(
    "butler_set_model",
    "Switch the butler's model live (no session restart, context preserved). Pass an empty model string to revert to the profile/CLI default.",
    {
      projectId: z.string().describe("The project ID"),
      model: z.string().describe('Model name (e.g. "opus", "sonnet", "haiku") or empty string to use the profile default'),
    },
    async ({ projectId, model }) => {
      return await butlerCall("Butler set-model", `/api/projects/${projectId}/butler/model`, {
        method: "POST",
        body: JSON.stringify({ model }),
      });
    },
  );
}
