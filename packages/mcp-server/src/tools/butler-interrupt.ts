import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { butlerCall } from "../butler-api.js";

export function registerButlerInterrupt(server: McpServer) {
  server.tool(
    "butler_interrupt",
    "Interrupt the butler's in-flight turn. The warm session is preserved (context is kept); only the current response generation is cancelled.",
    {
      projectId: z.string().describe("The project ID"),
    },
    async ({ projectId }) => {
      return await butlerCall("Butler interrupt", `/api/projects/${projectId}/butler/interrupt`, {
        method: "POST",
        body: "{}",
      });
    },
  );
}
