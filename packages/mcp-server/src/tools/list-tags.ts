import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db, schema } from "../db.js";
import { mcpJson } from "../db-utils.js";

export function registerListTags(server: McpServer) {
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
