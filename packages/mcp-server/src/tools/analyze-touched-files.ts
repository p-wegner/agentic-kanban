import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { boardApi, boardErrorText, mcpJson } from "../board-call.js";
import { mcpError } from "../db-utils.js";

export function registerAnalyzeTouchedFiles(server: McpServer) {
  server.tool(
    "analyze_touched_files",
    "Predict which source files an issue will likely modify using a fast AI model. Results are cached on the issue. Re-running with refresh=true forces a new prediction.",
    {
      issueId: z.string().describe("The issue ID to analyze"),
      refresh: z.boolean().optional().default(false).describe("Force re-analysis even if a cached result exists"),
    },
    async ({ issueId, refresh }) => {
      const { ok, statusText, data } = await boardApi(`/api/issues/${issueId}/analyze-touched-files`, {
        method: "POST",
        body: JSON.stringify({ refresh: refresh ?? false }),
      });
      if (!ok) return mcpError(`Error: ${boardErrorText(data, statusText)}`);
      return mcpJson(data);
    },
  );
}
