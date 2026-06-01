import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { boardApiUrl } from "../server-url.js";

export function registerAnalyzeTouchedFiles(server: McpServer) {
  server.tool(
    "analyze_touched_files",
    "Predict which source files an issue will likely modify using a fast AI model. Results are cached on the issue. Re-running with refresh=true forces a new prediction.",
    {
      issueId: z.string().describe("The issue ID to analyze"),
      refresh: z.boolean().optional().default(false).describe("Force re-analysis even if a cached result exists"),
    },
    async ({ issueId, refresh }) => {
      const res = await fetch(boardApiUrl(`/api/issues/${issueId}/analyze-touched-files`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh: refresh ?? false }),
      });
      if (!res.ok) {
        const err = await res.text().catch(() => res.statusText);
        return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
      }
      const result = await res.json();
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
