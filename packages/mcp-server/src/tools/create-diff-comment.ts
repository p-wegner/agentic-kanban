import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { requireEntity } from "../db-utils.js";

export function registerCreateDiffComment(server: McpServer) {
  server.tool(
    "create_diff_comment",
    "Add a review comment on a file in a workspace's diff",
    {
      workspaceId: z.string().describe("The workspace ID to comment on"),
      filePath: z.string().describe("File path the comment is on"),
      body: z.string().describe("Comment text"),
      lineNumOld: z.number().optional().describe("Line number on the old (base) side of the diff"),
      lineNumNew: z.number().optional().describe("Line number on the new (changed) side of the diff"),
      side: z.enum(["new", "old"]).optional().describe("Which side of the diff (default: 'new')"),
    },
    async ({ workspaceId, filePath, body, lineNumOld, lineNumNew, side }) => {
      const wsRows = await db.select().from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1);
      const r = requireEntity(wsRows, workspaceId, "Workspace");
      if (!r.ok) return r.error;

      const now = new Date().toISOString();
      const comment = {
        id: randomUUID(),
        workspaceId,
        filePath,
        lineNumOld: lineNumOld ?? null,
        lineNumNew: lineNumNew ?? null,
        side: side || "new",
        body,
        createdAt: now,
        updatedAt: now,
      };

      await db.insert(schema.diffComments).values(comment);

      return {
        content: [{ type: "text" as const, text: JSON.stringify(comment, null, 2) }],
      };
    },
  );
}
