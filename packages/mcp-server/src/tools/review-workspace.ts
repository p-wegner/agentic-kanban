import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { prodDeps, type ToolDeps } from "./deps.js";
import { boardApi, boardErrorText, mcpJson, mcpText } from "../board-call.js";
import { eq } from "drizzle-orm";
import { notifyBoard } from "../notify.js";
import { requireEntity } from "../db-utils.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

export function registerReviewWorkspace(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;

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
        const { ok, statusText, data: raw } = await boardApi(`/api/workspaces/${workspaceId}/review`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        const data = (raw ?? {}) as { sessionId?: string };

        if (!ok) {
          return mcpText(`Review failed: ${boardErrorText(raw, statusText)}`);
        }

        // Resolve projectId for board notification
        const issueRows = await db.select({ projectId: schema.issues.projectId })
          .from(schema.issues)
          .where(eq(schema.issues.id, r.value.issueId))
          .limit(1);
        if (issueRows[0]?.projectId) {
          notifyBoard(issueRows[0].projectId, "mcp_review_workspace");
        }

        return mcpJson({ id: workspaceId, sessionId: data.sessionId });
      } catch (err) {
        return mcpText(`Review failed: ${errorMessage(err)}`);
      }
    },
  );
}
