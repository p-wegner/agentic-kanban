import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { prodDeps, type ToolDeps } from "./deps.js";
import { boardApiText, mcpText } from "../board-call.js";
import { mcpError } from "../db-utils.js";
import { eq } from "drizzle-orm";

export function registerAnalyzeDependencies(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;

  server.tool(
    "analyze_dependencies",
    "Analyze one issue against the current board and create inferred dependency edges. Use after creating related child issues so independent tasks remain unblocked and dependent tasks stay blocked.",
    {
      issueId: z.string().describe("Issue ID to analyze"),
      projectId: z.string().optional().describe("Project ID. Defaults to the issue's project."),
    },
    async ({ issueId, projectId }) => {
      let pid = projectId;
      if (!pid) {
        const rows = await db
          .select({ projectId: schema.issues.projectId })
          .from(schema.issues)
          .where(eq(schema.issues.id, issueId))
          .limit(1);
        if (rows.length === 0) {
          return mcpError(`Error: issue not found: ${issueId}`);
        }
        pid = rows[0].projectId;
      }

      const { ok, status, text } = await boardApiText("/api/issues/analyze-dependencies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueId, projectId: pid }),
      });
      if (!ok) return mcpError(`Error: dependency analysis failed (${status}): ${text}`);
      return mcpText(text);
    },
  );
}
