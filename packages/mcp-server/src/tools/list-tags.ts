import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";

export function registerListTags(server: McpServer) {
  server.tool(
    "list_tags",
    "List all available tags (labels) for categorizing issues",
    {},
    async () => {
      const result = await db.select().from(schema.tags);

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
