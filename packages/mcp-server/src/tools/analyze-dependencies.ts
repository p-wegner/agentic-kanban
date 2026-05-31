import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../db.js";

const SERVER_PORT = Number(process.env.SERVER_PORT) || 3001;

export function registerAnalyzeDependencies(server: McpServer) {
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
          return { content: [{ type: "text" as const, text: `Error: issue not found: ${issueId}` }] };
        }
        pid = rows[0].projectId;
      }

      const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/issues/analyze-dependencies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueId, projectId: pid }),
      });
      const text = await res.text();
      if (!res.ok) {
        return { content: [{ type: "text" as const, text: `Error: dependency analysis failed (${res.status}): ${text}` }] };
      }
      return { content: [{ type: "text" as const, text }] };
    },
  );
}
