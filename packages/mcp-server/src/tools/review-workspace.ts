import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";
import { notifyBoard } from "../notify.js";
import { requireEntity } from "../db-utils.js";
import { boardApiUrl } from "../server-url.js";

export function registerReviewWorkspace(server: McpServer) {
  server.tool(
    "review_workspace",
    "Trigger an AI code review for an idle workspace. The workspace must be in 'idle' status.",
    {
      workspaceId: z.string().describe("The workspace ID to review"),
    },
    async ({ workspaceId }) => {
      const wsRows = await db.select().from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1);
      const r = requireEntity(wsRows, workspaceId, "Workspace");
      if (!r.ok) return r.error;

      try {
        const res = await fetch(boardApiUrl(`/api/workspaces/${workspaceId}/review`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const data = await res.json() as Record<string, unknown>;

        if (!res.ok) {
          return { content: [{ type: "text" as const, text: `Review failed: ${data.error ?? res.statusText}` }] };
        }

        // Resolve projectId for board notification
        const issueRows = await db.select({ projectId: schema.issues.projectId })
          .from(schema.issues)
          .where(eq(schema.issues.id, r.value.issueId))
          .limit(1);
        if (issueRows[0]?.projectId) {
          notifyBoard(issueRows[0].projectId, "mcp_review_workspace");
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ id: workspaceId, sessionId: data.sessionId }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Review failed: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );
}
