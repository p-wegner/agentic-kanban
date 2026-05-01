import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerListIssues(server: McpServer) {
  server.tool(
    "list_issues",
    "List all issues for a project, optionally filtered by status",
    {
      projectId: z.string().describe("The project ID"),
      status: z
        .string()
        .optional()
        .describe("Filter by status name (e.g., 'Todo', 'In Progress')"),
    },
    async ({ projectId, status }) => {
      // TODO: Connect to the same SQLite database and query issues
      // For now, return a stub response
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              projectId,
              status,
              issues: [],
              message:
                "MCP server is a stub - full implementation deferred to Stage 4",
            }),
          },
        ],
      };
    },
  );
}
