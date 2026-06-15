import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";

export function registerSetPreference(server: McpServer) {
  server.tool(
    "set_preference",
    "Set (upsert) a preference value by key. Mirrors CLI `preferences set <key> <value>`. Writes directly to the preferences table. Use get_preference to read it back.",
    {
      key: z.string().describe("The preference key to set (e.g. 'projects_base_path', 'auto_merge', 'claude_profile')"),
      value: z.string().describe("The value to store for this preference key"),
    },
    async ({ key, value }) => {
      const now = new Date().toISOString();
      await db
        .insert(schema.preferences)
        .values({ key, value, updatedAt: now })
        .onConflictDoUpdate({ target: schema.preferences.key, set: { value, updatedAt: now } });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ key, value, updatedAt: now, ok: true }),
          },
        ],
      };
    },
  );
}
