import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { randomUUID } from "node:crypto";
import { mcpJson } from "../db-utils.js";

export function registerCreateTag(server: McpServer) {
  server.tool(
    "create_tag",
    "Create a new tag (label) for categorizing issues",
    {
      name: z.string().describe("Tag name (e.g., 'bug', 'feature', 'enhancement')"),
      color: z.string().optional().describe("Tag color as hex code (e.g., '#ff0000')"),
    },
    async ({ name, color }) => {
      const id = randomUUID();
      await db.insert(schema.tags).values({
        id,
        name,
        color: color ?? null,
        createdAt: new Date().toISOString(),
      });

      return mcpJson({ id, name, color: color ?? null });
    },
  );
}
