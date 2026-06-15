import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";

export function registerGetPreference(server: McpServer) {
  server.tool(
    "get_preference",
    "Get a preference value by key. Mirrors CLI `preferences get <key>`. Returns the stored value string, or a message indicating it is not set.",
    {
      key: z.string().describe("The preference key to retrieve (e.g. 'projects_base_path', 'auto_merge', 'claude_profile')"),
    },
    async ({ key }) => {
      const rows = await db
        .select()
        .from(schema.preferences)
        .where(eq(schema.preferences.key, key))
        .limit(1);

      if (rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ key, value: null, set: false }) }],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ key, value: rows[0].value, set: true, updatedAt: rows[0].updatedAt }),
          },
        ],
      };
    },
  );
}
