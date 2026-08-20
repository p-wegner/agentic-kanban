import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { prodDeps, type ToolDeps } from "./deps.js";
import { mcpJson } from "../db-utils.js";

export function registerListWorkspaces(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;

  server.tool(
    "list_workspaces",
    "List workspaces, optionally filtered by issue ID",
    {
      issueId: z.string().optional().describe("Filter by issue ID"),
      status: z.string().optional().describe("Filter by status (active, idle, closed)"),
    },
    async ({ issueId, status }) => {
      if (issueId) {
        const result = await db.select().from(schema.workspaces)
          .where(eq(schema.workspaces.issueId, issueId));
        return mcpJson(result);
      }

      const allWorkspaces = await db.select().from(schema.workspaces);

      const filtered = status
        ? allWorkspaces.filter(w => w.status === status)
        : allWorkspaces;

      return mcpJson(filtered);
    },
  );
}
