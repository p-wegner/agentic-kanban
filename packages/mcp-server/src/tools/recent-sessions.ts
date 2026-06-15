import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { prodDeps, type ToolDeps } from "./deps.js";

/**
 * Mirrors `pnpm cli -- session recent`.
 * Lists the most recent sessions across all workspaces with metadata.
 */
export function registerRecentSessions(server: McpServer, deps: ToolDeps = prodDeps) {
  const { db, schema } = deps;

  server.tool(
    "recent_sessions",
    "List the most recent agent sessions across all workspaces with metadata (status, executor, workspace, issue). Mirrors `pnpm cli -- session recent`.",
    {
      limit: z.number().int().positive().max(20).optional().describe("Number of sessions to show (default: 5, max: 20)"),
    },
    async ({ limit }) => {
      const n = Math.min(limit ?? 5, 20);

      const rows = await db
        .select({
          sessionId: schema.sessions.id,
          sessionStatus: schema.sessions.status,
          startedAt: schema.sessions.startedAt,
          endedAt: schema.sessions.endedAt,
          executor: schema.sessions.executor,
          triggerType: schema.sessions.triggerType,
          workspaceId: schema.workspaces.id,
          branch: schema.workspaces.branch,
          wsStatus: schema.workspaces.status,
          issueNumber: schema.issues.issueNumber,
          issueTitle: schema.issues.title,
        })
        .from(schema.sessions)
        .innerJoin(schema.workspaces, eq(schema.sessions.workspaceId, schema.workspaces.id))
        .innerJoin(schema.issues, eq(schema.workspaces.issueId, schema.issues.id))
        .orderBy(desc(schema.sessions.startedAt))
        .limit(n);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(
            rows.map((r) => ({
              sessionId: r.sessionId,
              sessionStatus: r.sessionStatus,
              startedAt: r.startedAt,
              endedAt: r.endedAt,
              executor: r.executor,
              triggerType: r.triggerType,
              workspace: { id: r.workspaceId, branch: r.branch, status: r.wsStatus },
              issue: { number: r.issueNumber, title: r.issueTitle },
            })),
            null,
            2,
          ),
        }],
      };
    },
  );
}
