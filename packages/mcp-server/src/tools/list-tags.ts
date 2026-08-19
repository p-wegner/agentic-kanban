import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { prodDeps, type ToolDeps } from "./deps.js";
import { mcpJson } from "../db-utils.js";

export function registerListTags(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;

  server.tool(
    "list_tags",
    "List all available tags (labels) for categorizing issues",
    {},
    async () => {
      const result = await db.select().from(schema.tags);

      return mcpJson(result);
    },
  );
}
